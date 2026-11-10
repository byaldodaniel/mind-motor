import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {agentFixture,connection} from './helpers/agent-fixture.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function setup(t){
  const f=await agentFixture(t);const session=await f.open();
  const folder=await session.motor.authorizeFolder(f.folder);
  await session.policy.set(folder.id,['encontrar','leer','escribir','organizar'],{channel:'administracion-local'});
  await session.policy.setContinuity(['leer','registrar'],{channel:'administracion-local'});
  return {...f,session,folderId:folder.id,call:f.agent(session,connection())};
}
test('traslado único reúne memoria y archivos dispersos, conserva bytes/ID y otro agente continúa',async t=>{
 const f=await setup(t);
 const saved=await f.call('conversacion_guardar',{titulo:'Campaña Duna',importante:'Aprobadas 23 cajas para viernes. Pendiente transportista.',proyecto:'Duna'});
 assert.equal(saved.isError,false,saved.text);const item=saved.data.conversacion;
 const originalMemory=await fs.readFile(item.archivo);
 const doc=await f.call('crear',{ruta:'propuesta.md',contenido:'Documento original de Duna.',conversacion:item.id});
 assert.equal(doc.isError,false,doc.text);
 const originalImage=path.join(f.folder,'portada.png');const bytes=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
 await fs.writeFile(originalImage,bytes);
 assert.equal((await f.call('resultado_registrar',{conversacion:item.id,ruta:originalImage,tipo:'imagenes'})).isError,false);
 const chosen=path.join(f.folder,'Proyecto Duna','Conversación');
 const moved=await f.call('conversacion_trasladar',{id:item.id,revision:item.revision,destino:chosen});
 assert.equal(moved.isError,false,moved.text);assert.equal(moved.data.estado,'trasladada',moved.text);
 assert.equal(moved.data.id,item.id);assert.equal(moved.data.archivos.length,3);
 for(const file of moved.data.archivos)assert.equal(hash(await fs.readFile(file.archivo)),file.sha256);
 assert.deepEqual(await fs.readFile(originalImage),bytes);assert.deepEqual(await fs.readFile(item.archivo),originalMemory);
 const second=await f.open();const call=f.agent(second,connection({clientInfo:{name:'Otro agente',version:'1'}}));
 const found=await call('conversaciones_buscar',{modo:'palabras',consulta:'Duna'});assert.equal(found.data.conversaciones[0].id,item.id);
 const current=(await call('conversacion_leer',{id:item.id})).data.conversacion;
 assert.equal(current.resultados.length,2);assert.ok(current.resultados.every(file=>file.archivo.startsWith(chosen+path.sep)));
 const updated=await call('conversacion_guardar',{id:item.id,revision:current.revision,importante:'Corregido: 31 cajas para lunes. Pendiente transportista.'});
 assert.equal(updated.data.estado,'actualizada',updated.text);assert.equal(updated.data.conversacion.archivo,current.archivo);
 assert.match(await fs.readFile(current.archivo,'utf8'),/31 cajas/);assert.deepEqual(await fs.readFile(item.archivo),originalMemory);
 const next=await call('crear',{ruta:'siguiente.svg',contenido:'<svg/>',conversacion:item.id});
 assert.equal(next.data.ruta_absoluta,path.join(chosen,'imagenes','siguiente.svg'),next.text);
});
test('revisión antigua, destino ajeno y colisión no alteran memoria ni reemplazan archivos',async t=>{
 const f=await setup(t);const saved=(await f.call('conversacion_guardar',{titulo:'Conservar',importante:'Decisión original.'})).data.conversacion;
 const target=path.join(f.folder,'Destino');
 assert.equal((await f.call('conversacion_trasladar',{id:saved.id,revision:99,destino:target})).code,'CONTINUITY_REVISION_CONFLICT');
 assert.equal((await f.call('conversacion_trasladar',{id:saved.id,revision:1,destino:path.join(f.root,'Sin permiso')})).code,'FOLDER_NOT_AUTHORIZED');
 const collision=path.join(target,'memoria',path.basename(saved.archivo));await fs.mkdir(path.dirname(collision),{recursive:true});await fs.writeFile(collision,'Archivo ajeno.');
 assert.equal((await f.call('conversacion_trasladar',{id:saved.id,revision:1,destino:target})).code,'FILE_EXISTS');
 assert.equal(await fs.readFile(collision,'utf8'),'Archivo ajeno.');
 assert.equal((await f.call('conversacion_leer',{id:saved.id})).data.conversacion.archivo,saved.archivo);
 await fs.appendFile(saved.archivo,'\nApunte manual del usuario.');
 assert.equal((await f.call('conversacion_trasladar',{id:saved.id,revision:1,destino:path.join(f.folder,'Otro destino')})).code,'CONVERSATION_FILE_CONFLICT');
 assert.match(await fs.readFile(saved.archivo,'utf8'),/Apunte manual/);
});
test('dos archivos del mismo nombre conservan ambos resultados y una conversación ajena queda intacta',async t=>{
 const f=await setup(t);const a=(await f.call('conversacion_guardar',{titulo:'A',importante:'A'})).data.conversacion;
 const b=(await f.call('conversacion_guardar',{titulo:'B',importante:'B'})).data.conversacion;
 for(const [dir,value] of [['uno','Primero'],['dos','Segundo']]){
   const file=path.join(f.folder,dir,'informe.txt');await fs.mkdir(path.dirname(file));await fs.writeFile(file,value);
   assert.equal((await f.call('resultado_registrar',{conversacion:a.id,ruta:file})).isError,false);
 }
 const moved=await f.call('conversacion_trasladar',{id:a.id,revision:1,destino:path.join(f.folder,'Elegido')});
 assert.equal(moved.data.estado,'trasladada',moved.text);
 const actual=(await f.call('conversacion_leer',{id:a.id})).data.conversacion;
 assert.equal(actual.resultados.length,2);assert.notEqual(actual.resultados[0].archivo,actual.resultados[1].archivo);
 assert.deepEqual((await Promise.all(actual.resultados.map(x=>fs.readFile(x.archivo,'utf8')))).sort(),['Primero','Segundo']);
 assert.equal((await f.call('conversacion_leer',{id:b.id})).data.conversacion.archivo,b.archivo);
});
test('un resultado nuevo durante la copia impide publicar una lista incompleta y conserva el origen',async t=>{
 const f=await setup(t);const item=(await f.call('conversacion_guardar',{titulo:'Concurrente',importante:'Decisión que debe conservarse.'})).data.conversacion;
 await f.call('crear',{ruta:'primero.txt',contenido:'Primero',conversacion:item.id});
 const original=await fs.readFile(item.archivo);let injected=false;
 const session={...f.session,motor:{...f.session.motor,copyResultFile:async request=>{
   const copied=await f.session.motor.copyResultFile(request);
   if(!injected){injected=true;const late=path.join(f.folder,'ultimo.txt');await fs.writeFile(late,'Creado durante traslado');await f.session.motor.rememberConversationResult(item.id,{path:late,type:'documentos',bytes:Buffer.byteLength('Creado durante traslado')});}
   return copied;
 }}};
 const call=f.agent(session,connection());
 const moved=await call('conversacion_trasladar',{id:item.id,revision:item.revision,destino:path.join(f.folder,'Incompleto')});
 assert.equal(moved.data.estado,'pendiente',moved.text);assert.equal(moved.data.codigo,'RESULTS_REVISION_CONFLICT');
 const read=(await f.call('conversacion_leer',{id:item.id})).data.conversacion;
 assert.equal(read.archivo,item.archivo);assert.equal(read.resultados.length,2);assert.deepEqual(await fs.readFile(item.archivo),original);
 assert.equal(read.importante,'Decisión que debe conservarse.');
});
test('referencias a carpetas permanecen externas, archivos referenciados y resultados memoria se conservan',async t=>{
 const f=await setup(t);const reference=path.join(f.folder,'referencia.txt');await fs.writeFile(reference,'Referencia importante.');
 const item=(await f.call('conversacion_guardar',{titulo:'Referencias',importante:'Conservar todas.',referencias:[{ubicacion:f.folder,relacion:'proyecto'},{ubicacion:reference,relacion:'archivo'}]})).data.conversacion;
 const extra=path.join(f.folder,'segunda-memoria.md');await fs.writeFile(extra,'Segundo documento de memoria.');
 await f.call('resultado_registrar',{conversacion:item.id,ruta:extra,tipo:'memoria'});
 const destination=path.join(f.folder,'Referencias trasladadas');
 const moved=await f.call('conversacion_trasladar',{id:item.id,revision:item.revision,destino:destination});assert.equal(moved.data.estado,'trasladada',moved.text);
 const read=(await f.call('conversacion_leer',{id:item.id})).data.conversacion;
 assert.equal(read.resultados.length,2);assert.ok(read.resultados.some(result=>result.tipo==='memoria'));
 assert.equal(read.referencias.find(ref=>ref.relacion==='proyecto').ubicacion,f.folder);
 const file=read.referencias.find(ref=>ref.relacion==='archivo').ubicacion;assert.ok(file.startsWith(destination+path.sep));assert.equal(await fs.readFile(file,'utf8'),'Referencia importante.');
 assert.equal((await f.call('conversacion_preferencias',{id:item.id})).data.heredada,true);
 await f.call('conversacion_configurar',{revision:0,preferencias:{modo:'manual'}});
 assert.equal((await f.call('conversacion_preferencias',{id:item.id})).data.efectiva.modo,'manual');
});
test('una copia interrumpida se reintenta en el mismo destino sin duplicar ni reemplazar contenido',async t=>{
 const f=await setup(t);const item=(await f.call('conversacion_guardar',{titulo:'Reintentar',importante:'Acuerdo conservado.'})).data.conversacion;
 await f.call('crear',{ruta:'documento.txt',contenido:'Documento íntegro.',conversacion:item.id});
 let count=0;const session={...f.session,motor:{...f.session.motor,copyResultFile:async request=>{if(++count===2)throw Object.assign(new Error('Interrupción de prueba'),{code:'COPY_FAILED'});return f.session.motor.copyResultFile(request);}}};
 const chosen=path.join(f.folder,'Reintento');const interrupted=await f.agent(session,connection())('conversacion_trasladar',{id:item.id,revision:item.revision,destino:chosen});
 assert.equal(interrupted.data.estado,'pendiente');assert.equal(interrupted.data.archivos_copiados.length,1);
 const retry=await f.call('conversacion_trasladar',{id:item.id,revision:item.revision,destino:chosen});assert.equal(retry.data.estado,'trasladada',retry.text);
 assert.equal(retry.data.archivos.length,2);const current=(await f.call('conversacion_leer',{id:item.id})).data.conversacion;
 assert.equal(current.resultados.length,1);assert.equal(await fs.readFile(current.resultados[0].archivo,'utf8'),'Documento íntegro.');
 const again=await f.call('conversacion_trasladar',{id:item.id,revision:current.revision,destino:chosen});assert.equal(again.data.estado,'trasladada');assert.equal(again.data.ya_trasladada,true);
 const extra=path.join(f.folder,'archivo-añadido.txt');await fs.writeFile(extra,'Añadido después.');await f.call('resultado_registrar',{conversacion:item.id,ruta:extra});
 const gathered=await f.call('conversacion_trasladar',{id:item.id,revision:current.revision,destino:chosen});assert.equal(gathered.data.estado,'trasladada',gathered.text);
 const final=(await f.call('conversacion_leer',{id:item.id})).data.conversacion;assert.equal(final.resultados.length,2);assert.ok(final.resultados.every(file=>file.archivo.startsWith(chosen+path.sep)));
 await fs.unlink(final.resultados[0].archivo);
 assert.ok(['FILE_NOT_FOUND','PARENT_NOT_FOUND'].includes((await f.call('conversacion_trasladar',{id:item.id,revision:final.revision,destino:chosen})).code));
});

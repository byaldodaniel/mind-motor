import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {agentFixture,connection} from './helpers/agent-fixture.js';
import {RELOCATION_FILE} from '../src/conversation-relocation.js';
import {matchesConversationMarkdown} from '../src/conversation-file.js';

async function setup(t) {
  const f=await agentFixture(t);const session=await f.open();
  const folder=await session.motor.authorizeFolder(f.folder);
  await session.policy.set(folder.id,['encontrar','leer','escribir','organizar'],{channel:'administracion-local'});
  await session.policy.setContinuity(['leer','registrar'],{channel:'administracion-local'});
  return {...f,session,folderId:folder.id,call:f.agent(session,connection())};
}
test('mover carpeta conserva ID, memoria, recursos y preferencias y se continúa desde otro agente',async t=>{
  const f=await setup(t),source=path.join(f.folder,'Ensayo'),target=path.join(f.folder,'Proyecto','Conversacion');
  await fs.mkdir(path.dirname(target));
  await f.call('conversacion_configurar',{revision:0,preferencias:{modo:'esencial',carpeta_destino:path.join(source,'Memoria')}});
  await f.call('destinos_configurar',{revision:0,destinos:{carpeta:source,tipos:{imagenes:path.join(source,'Imagenes'),documentos:path.join(source,'Documentos')}}});
  const saved=await f.call('conversacion_guardar',{titulo:'Ensayo',importante:'Ruta citada literalmente: '+source,destino:path.join(source,'Memoria','decisiones.md'),
    referencias:[{ubicacion:path.join(source,'Imagenes','grafico.svg')},{ubicacion:source+'-ajeno'},{ubicacion:'https://example.test/Ensayo'}]});
  assert.equal(saved.isError,false,saved.text);const id=saved.data.conversacion.id;
  assert.equal((await f.call('crear',{ruta:'grafico.svg',contenido:'<svg/>',conversacion:id})).isError,false);
  assert.equal((await f.call('crear',{ruta:'informe.md',contenido:'Informe.',conversacion:id})).isError,false);
  assert.equal((await f.call('conversacion_configurar',{id,revision:1,preferencias:{modo:'detallado',carpeta_destino:path.join(source,'Memoria')}})).isError,false);
  assert.equal((await f.call('destinos_configurar',{revision:1,conversacion:id,destinos:{tipos:{memoria:path.join(source,'Memoria')}}})).isError,false);
  const moved=await f.call('mover',{carpeta:f.folderId,desde:'Ensayo',hasta:'Proyecto/Conversacion'});
  assert.equal(moved.isError,false,moved.text);assert.equal(moved.data.continuidad.estado,'actualizada',moved.text);
  const other=await f.open();const call=f.agent(other,connection());
  const read=await call('conversacion_leer',{id});assert.equal(read.isError,false,read.text);
  const item=read.data.conversacion;assert.equal(item.id,id);assert.equal(item.archivo,path.join(target,'Memoria','decisiones.md'));
  assert.equal(item.importante,'Ruta citada literalmente: '+source);
  assert.equal(item.referencias[0].ubicacion,path.join(target,'Imagenes','grafico.svg'));
  assert.equal(item.referencias[1].ubicacion,source+'-ajeno');assert.equal(item.referencias[2].ubicacion,'https://example.test/Ensayo');
  assert.deepEqual(item.resultados.map(x=>x.archivo).sort(),[path.join(target,'Imagenes','grafico.svg'),path.join(target,'Documentos','informe.md')].sort());
  const preferences=await call('conversacion_preferencias',{id});
  assert.equal(preferences.data.general.carpeta_destino,path.join(target,'Memoria'));
  assert.equal(preferences.data.excepcion.carpeta_destino,path.join(target,'Memoria'));
  const destinations=await call('destinos_consultar',{conversacion:id});
  assert.equal(destinations.data.efectivos.imagenes,path.join(target,'Imagenes'));
  const updated=await call('conversacion_guardar',{id,revision:item.revision,importante:'Acuerdo actualizado.'});
  assert.equal(updated.data.estado,'actualizada',updated.text);
  assert.match(await fs.readFile(item.archivo,'utf8'),/Acuerdo actualizado/);
  await assert.rejects(fs.stat(source),{code:'ENOENT'});
  const next=await call('crear',{ruta:'nuevo.svg',contenido:'<svg/>',conversacion:id});
  assert.equal(next.data.ruta_absoluta,path.join(target,'Imagenes','nuevo.svg'));
});
test('configurar preferencias no confunde el marcador anterior con una edición externa',async t=>{
  const f=await setup(t),saved=await f.call('conversacion_guardar',{titulo:'Marcador',importante:'Vigente.'});
  const id=saved.data.conversacion.id;
  const configured=await f.call('conversacion_configurar',{id,revision:1,preferencias:{modo:'detallado'}});
  assert.equal(configured.isError,false,configured.text);
  const updated=await f.call('conversacion_guardar',{id,revision:2,importante:'Nuevo acuerdo.'});
  assert.equal(updated.data.estado,'actualizada',updated.text);
  await fs.appendFile(updated.data.conversacion.archivo,'Nota del usuario.');
  const rejected=await f.call('conversacion_guardar',{id,revision:3,importante:'No sustituir.'});
  assert.equal(rejected.code,'CONVERSATION_FILE_CONFLICT');
  assert.match(await fs.readFile(updated.data.conversacion.archivo,'utf8'),/Nota del usuario/);
  const native=await f.session.motor.getConversation(id);
  assert.equal(matchesConversationMarkdown('<!-- mind-conversation:'+id+' revision:999 -->\n# Marcador\n\nNuevo acuerdo.\n',native),false);
});
test('renombrar memoria actualiza su ruta sin recrear el nombre anterior',async t=>{
  const f=await setup(t),saved=await f.call('conversacion_guardar',{titulo:'Nombre',importante:'Vigente.',destino:path.join(f.folder,'antes.md')});
  const id=saved.data.conversacion.id;
  const renamed=await f.call('renombrar',{ruta:'antes.md',nuevo_nombre:'despues.md'});
  assert.equal(renamed.data.continuidad.estado,'actualizada',renamed.text);
  const item=(await f.call('conversacion_leer',{id})).data.conversacion;
  assert.equal(item.archivo,path.join(f.folder,'despues.md'));
  assert.equal((await f.call('conversacion_guardar',{id,revision:item.revision,importante:'Continúa.'})).data.estado,'actualizada');
  await assert.rejects(fs.stat(path.join(f.folder,'antes.md')),{code:'ENOENT'});
});
test('fallo de metadatos tras mover se registra y otra sesión lo recupera antes de guardar',async t=>{
  const f=await setup(t),source=path.join(f.folder,'Origen'),target=path.join(f.folder,'Destino');
  await f.call('destinos_configurar',{revision:0,destinos:{carpeta:source}});
  const saved=await f.call('conversacion_guardar',{titulo:'Recuperable',importante:'Vigente.'}),id=saved.data.conversacion.id;
  await f.call('crear',{ruta:'resultado.svg',contenido:'<svg/>',conversacion:id});
  const lock=path.join(f.layout.baseDirectory,'conversation-results-'+id+'.lock');
  await fs.writeFile(lock,JSON.stringify({pid:process.pid,host:os.hostname()}));
  const moved=await f.call('mover',{desde:'Origen',hasta:'Destino'});
  assert.equal(moved.isError,false,moved.text);assert.equal(moved.data.continuidad.estado,'pendiente',moved.text);
  assert.ok(await fs.stat(path.join(f.layout.baseDirectory,RELOCATION_FILE)));
  const blocked=await f.call('conversacion_leer',{id});assert.equal(blocked.code,'CONVERSATION_RELOCATION_PENDING');
  await fs.unlink(lock);
  const other=await f.open(),call=f.agent(other,connection());
  const read=await call('conversacion_leer',{id});assert.equal(read.isError,false,read.text);
  assert.ok(read.data.conversacion.resultados.every(value=>value.archivo.startsWith(target+path.sep)));
  const item=read.data.conversacion;
  assert.equal((await call('conversacion_guardar',{id,revision:item.revision,importante:'Después de recuperación.'})).data.estado,'actualizada');
  await assert.rejects(fs.stat(source),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.layout.baseDirectory,RELOCATION_FILE)),{code:'ENOENT'});
});
test('un movimiento rechazado no deja bloqueada la continuidad',async t=>{
  const f=await setup(t),saved=await f.call('conversacion_guardar',{titulo:'Sin pérdida',importante:'Vigente.',destino:path.join(f.folder,'antes.md')});
  await fs.writeFile(path.join(f.folder,'ocupado.md'),'Ajeno.');
  assert.equal((await f.call('mover',{desde:'antes.md',hasta:'ocupado.md'})).code,'FILE_EXISTS');
  assert.equal((await f.call('conversacion_leer',{id:saved.data.conversacion.id})).isError,false);
  await assert.rejects(fs.stat(path.join(f.layout.baseDirectory,RELOCATION_FILE)),{code:'ENOENT'});
});

test('interrupción entre movimiento físico y confirmación se recupera por identidad sin perder el ID',async t=>{
  const f=await setup(t),source=path.join(f.folder,'antes.md'),target=path.join(f.folder,'despues.md');
  const saved=await f.call('conversacion_guardar',{titulo:'Interrumpida',importante:'Acuerdo.',destino:source});
  const held=await fs.lstat(source,{bigint:true});
  await fs.writeFile(path.join(f.layout.baseDirectory,RELOCATION_FILE),JSON.stringify({
    format:'mind-conversation-relocation',version:1,kind:'move',phase:'prepared',from:source,to:target,
    identity:{dev:String(held.dev),ino:String(held.ino)},ids:[saved.data.conversacion.id]
  }));
  await fs.rename(source,target);
  const read=await f.call('conversacion_leer',{id:saved.data.conversacion.id});
  assert.equal(read.isError,false,read.text);assert.equal(read.data.conversacion.archivo,target);
  await assert.rejects(fs.stat(path.join(f.layout.baseDirectory,RELOCATION_FILE)),{code:'ENOENT'});
});

test('metadatos corruptos preexistentes impiden mover antes de cambiar los archivos',async t=>{
  const f=await setup(t),saved=await f.call('conversacion_guardar',{titulo:'Conservar',importante:'Acuerdo.',destino:path.join(f.folder,'antes.md')});
  const corrupt=path.join(f.layout.baseDirectory,'continuity-'+saved.data.conversacion.id+'.json');
  await fs.writeFile(corrupt,'{corrupto');
  const rejected=await f.call('mover',{desde:'notas.txt',hasta:'otro.txt'});
  assert.equal(rejected.code,'RECORD_CORRUPT',rejected.text);
  assert.match(await fs.readFile(path.join(f.folder,'notas.txt'),'utf8'),/Notas ficticias/);
  await assert.rejects(fs.stat(path.join(f.folder,'otro.txt')),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.layout.baseDirectory,RELOCATION_FILE)),{code:'ENOENT'});
});

test('trasladar conserva referencias históricas retiradas y rebasa únicamente rutas locales',async t=>{
  const f=await setup(t),source=path.join(f.folder,'Origen'),target=path.join(f.folder,'Destino');
  const old=await f.session.motor.recordContinuity({kind:'decision',content:'Referencia histórica'});
  const saved=await f.call('conversacion_guardar',{titulo:'Historia',importante:'Vigente.',destino:path.join(source,'memoria.md'),
    referencias:[{registro:old.id},{ubicacion:path.join(source,'imagen.svg')}]});
  await f.session.motor.retireContinuity(old.id);
  const moved=await f.call('mover',{desde:'Origen',hasta:'Destino'});
  assert.equal(moved.isError,false,moved.text);assert.equal(moved.data.continuidad.estado,'actualizada',moved.text);
  const read=await f.call('conversacion_leer',{id:saved.data.conversacion.id});
  assert.equal(read.data.conversacion.referencias[0].registro,old.id);
  assert.equal(read.data.conversacion.referencias[1].ubicacion,path.join(target,'imagen.svg'));
});

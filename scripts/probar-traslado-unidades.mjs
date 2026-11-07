#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {openSession} from '../src/session.js';
import {createAgentTools} from '../src/agent-tools.js';
import {connection} from '../test/helpers/agent-fixture.js';

const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mind-unidades-')));
const parent='G:\\Mi unidad\\Aldo Daniel\\Mind\\Data\\Versiones';
const fixtureName='Prueba temporal traslado 1.0.3 - '+randomUUID();
const targetRoot=path.join(parent,fixtureName);
const target=path.join(targetRoot,'Conversacion');
const reportFile=process.argv[2];
if(!reportFile)throw new Error('Uso: probar-traslado-unidades.mjs <informe.json>');
const repository=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const mind=path.join(root,'Mind');const source=path.join(root,'Origen');
const sessions=[];
const report={formato:'mind-traslado-unidades',version:1,plataforma:process.platform+'-'+process.arch,origen:source,destino:target,resultado:'fallido',limite:'Lectura y escritura local de DriveFS; no certifica sincronización remota de Google Drive.'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const layout={product:false,root:mind,motorDirectory:repository,baseDirectory:path.join(mind,'Base'),pythonExecutable:process.platform==='win32'?'python':'python3',protectedDirectories:[mind]};
async function open(){const session=await openSession({layout,motorVersion:'1.0.3',observe:false});sessions.push(session);await session.start();return session;}
async function safeRemove(directory,expectedParent,prefix){
 const actual=await fs.realpath(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!actual)return;
 const actualParent=await fs.realpath(expectedParent);
 assert.equal(path.dirname(actual).toLowerCase(),actualParent.toLowerCase(),'El ensayo debe quedar dentro de su destino previsto.');
 assert.ok(path.basename(actual).startsWith(prefix),'Sólo se elimina la carpeta única de este ensayo.');
 const info=await fs.lstat(actual);assert.ok(info.isDirectory()&&!info.isSymbolicLink());
 await fs.rm(actual,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
try{
 await fs.mkdir(mind);await fs.mkdir(source);await fs.mkdir(targetRoot);
 report.dispositivos={origen:String((await fs.stat(source,{bigint:true})).dev),destino:String((await fs.stat(targetRoot,{bigint:true})).dev)};
 const session=await open();
 for(const directory of [source,targetRoot]){const folder=await session.motor.authorizeFolder(directory);await session.policy.set(folder.id,['encontrar','leer','escribir','organizar'],{channel:'administracion-local'});}
 await session.policy.setContinuity(['leer','registrar'],{channel:'administracion-local'});
 const tools=createAgentTools({session,connection:connection()});
 const saved=await tools.call('conversacion_guardar',{titulo:'Ensayo unidades Duna',importante:'Decisión vigente: 23 muestras para viernes. Pendiente confirmar transporte.',destino:path.join(source,'decisiones.md')},{});
 const id=saved.conversacion.id;report.id=id;
 const originalMemory=await fs.readFile(saved.conversacion.archivo);
 const doc=await tools.call('crear',{ruta:'informe.md',destino:path.join(source,'informe.md'),contenido:'# Informe ficticio\n23 muestras para viernes.\n',conversacion:id},{});
 const image=path.join(source,'imagen.png');const imageBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1cAAAAASUVORK5CYII=','base64');await fs.writeFile(image,imageBytes);
 await tools.call('resultado_registrar',{conversacion:id,ruta:image,tipo:'imagenes'},{});
 const moved=await tools.call('conversacion_trasladar',{id,revision:saved.conversacion.revision,destino:target},{});
 report.traslado=moved;
 if(moved.estado!=='trasladada'){report.resultado='rechazado_o_pendiente';throw Object.assign(new Error('No se confirmó el traslado: '+JSON.stringify(moved)),{code:moved.codigo});}
 assert.equal(moved.id,id);assert.equal(moved.archivos.length,3);
 for(const item of moved.archivos){assert.equal(hash(await fs.readFile(item.archivo)),item.sha256);assert.equal(hash(await fs.readFile(item.origen)),item.sha256);}
 await session.close();
 const next=await open(),other=createAgentTools({session:next,connection:connection({clientInfo:{name:'Segundo agente de ensayo',version:'1'}})});
 const read=await other.call('conversacion_leer',{id},{});assert.equal(read.conversacion.id,id);assert.match(read.conversacion.importante,/23 muestras para viernes/);
 const updated=await other.call('conversacion_guardar',{id,revision:read.conversacion.revision,importante:'Decisión vigente: 31 muestras para lunes; reemplaza 23 para viernes. Pendiente confirmar transporte.'},{});
 report.actualizacion=updated;assert.equal(updated.estado,'actualizada');assert.match(await fs.readFile(updated.conversacion.archivo,'utf8'),/31 muestras para lunes/);
 assert.deepEqual(await fs.readFile(saved.conversacion.archivo),originalMemory);
 assert.equal(read.conversacion.resultados.length,2);
 for(const item of read.conversacion.resultados)assert.equal(hash(await fs.readFile(item.archivo)),item.sha256);
 const renamed=await other.call('mover',{carpeta:targetRoot,desde:'Conversacion',hasta:'Continuacion'},{});
 assert.equal(renamed.estado,'movido');assert.equal(renamed.continuidad.estado,'actualizada');report.renombrado=renamed;
 await next.close();const third=await open(),finalTools=createAgentTools({session:third,connection:connection({clientInfo:{name:'Tercer agente de ensayo',version:'1'}})});
 const afterRename=await finalTools.call('conversacion_leer',{id},{});assert.equal(afterRename.conversacion.id,id);assert.match(afterRename.conversacion.importante,/31 muestras para lunes/);
 const renamedRoot=path.join(targetRoot,'Continuacion');assert.ok(afterRename.conversacion.archivo.startsWith(renamedRoot+path.sep));
 const last=await finalTools.call('conversacion_guardar',{id,revision:afterRename.conversacion.revision,importante:'31 muestras para lunes. Confirmado: continúa tras renombrar en G. Pendiente confirmar transporte.'},{});
 assert.equal(last.estado,'actualizada');assert.match(await fs.readFile(last.conversacion.archivo,'utf8'),/continúa tras renombrar/);
 const output=await finalTools.call('crear',{ruta:'nuevo.md',contenido:'Nuevo resultado en ubicación vigente.',conversacion:id},{});assert.ok(output.ruta_absoluta.startsWith(renamedRoot+path.sep));
 for(const item of afterRename.conversacion.resultados){assert.ok(item.archivo.startsWith(renamedRoot+path.sep));assert.equal(hash(await fs.readFile(item.archivo)),item.sha256);}
 await assert.rejects(fs.stat(target),{code:'ENOENT'});
 report.verificado={mismaIdentidad:true,memoriaActualizadaEnG:true,memoriaOriginalIntacta:true,resultados:2,huellasIntactas:true,revision:last.conversacion.revision,carpetaRenombrada:true,terceraSesionContinua:true,nuevoResultadoEnRutaVigente:true};
 report.resultado='superado';
}catch(error){report.codigo=error.code??null;report.error=error.stack;process.exitCode=1;}
finally{
 await Promise.allSettled(sessions.map(session=>session.close()));
 try{await safeRemove(targetRoot,parent,'Prueba temporal traslado 1.0.3 - ');await safeRemove(root,os.tmpdir(),'mind-unidades-');report.limpieza='Sólo carpetas únicas del ensayo eliminadas tras verificar sus rutas.';}
 catch(error){report.error_limpieza=error.stack;process.exitCode=1;}
 report.fecha=new Date().toISOString();await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({resultado:report.resultado,codigo:report.codigo??null,verificado:report.verificado??null,informe:reportFile}));
}

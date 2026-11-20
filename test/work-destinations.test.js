import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {agentFixture,connection} from './helpers/agent-fixture.js';
import {createAgentTools} from '../src/agent-tools.js';
import {createWorkspaceAccess} from '../src/workspace-access.js';

async function setup(t) {
 const f=await agentFixture(t);const session=await f.open();
 const folder=await session.motor.authorizeFolder(f.folder);
 await session.policy.set(folder.id,['encontrar','leer','escribir','organizar'],{channel:'administracion-local'});
 await session.policy.setContinuity(['leer','registrar'],{channel:'administracion-local'});
 const call=f.agent(session,connection());
 return {...f,session,call,folderId:folder.id};
}
test('destinos físicos persistentes, prioridad de conversación/proyecto y creación automática de código e imágenes',async t=>{
 const f=await setup(t);
 let configured=await f.call('destinos_configurar',{revision:0,destinos:{carpeta:path.join(f.folder,'General'),tipos:{imagenes:path.join(f.folder,'Fotos')}}});
 assert.equal(configured.isError,false,configured.text);
 const memory=await f.call('conversacion_guardar',{titulo:'Brisa',importante:'23 cajas.',proyecto:'Brisa'});
 assert.equal(memory.data.estado,'registrada',memory.text);
 const id=memory.data.conversacion.id;
 assert.equal(path.dirname(memory.data.conversacion.archivo),path.join(f.folder,'General'));
 assert.equal((await f.call('destinos_configurar',{revision:1,proyecto:'Brisa',destinos:{carpeta:path.join(f.folder,'Brisa')}})).isError,false);
 let result=await f.call('crear',{ruta:'src/app.js',contenido:'export const cajas=23;',proyecto:'Brisa',conversacion:id});
 assert.equal(result.isError,false,result.text);
 assert.equal(result.data.ruta_absoluta,path.join(f.folder,'Brisa','src','app.js'));
 assert.equal(await fs.readFile(result.data.ruta_absoluta,'utf8'),'export const cajas=23;');
 result=await f.call('crear',{ruta:'imagen.svg',contenido:'<svg/>',proyecto:'Otro'});
 assert.equal(result.data.ruta_absoluta,path.join(f.folder,'Fotos','imagen.svg'),result.text);
 assert.equal((await f.call('destinos_configurar',{revision:2,conversacion:id,destinos:{tipos:{documentos:path.join(f.folder,'Solo esta charla')}}})).isError,false);
 result=await f.call('crear',{ruta:'informe.md',contenido:'Acuerdo.',conversacion:id});
 assert.equal(result.data.ruta_absoluta,path.join(f.folder,'Solo esta charla','informe.md'),result.text);
 const another=await f.open();const read=f.agent(another,connection({clientInfo:{name:'otro cliente',version:'1'}}));
 const plan=await read('destinos_consultar',{conversacion:id});
 assert.equal(plan.data.efectivos.codigo,path.join(f.folder,'Brisa'));
 const item=await read('conversacion_leer',{id});
 assert.equal(item.data.conversacion.resultados.length,2,item.text);
 assert.ok(item.data.conversacion.resultados.some(x=>x.archivo.endsWith('app.js')));
 assert.equal((await read('destinos_configurar',{revision:0,destinos:null})).code,'DESTINATIONS_REVISION_CONFLICT');
});
test('resultado binario se copia físicamente, íntegro, con SHA, sin enlaces ni sobreescrituras',async t=>{
 const f=await setup(t);
 const bytes=Buffer.alloc(2*1024*1024+71);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 const origin=path.join(f.folder,'imagen.png');await fs.writeFile(origin,bytes);
 await f.call('destinos_configurar',{revision:0,destinos:{carpeta:path.join(f.folder,'Almacen')}});
 const memory=await f.call('conversacion_guardar',{titulo:'Media',importante:'Resultado ficticio.'});
 const id=memory.data.conversacion.id;
 const copied=await f.call('resultado_importar',{origen:origin,conversacion:id});
 assert.equal(copied.isError,false,copied.text);
 const target=copied.data.ruta_absoluta;
 assert.equal(target,path.join(f.folder,'Almacen','imagen.png'));
 assert.deepEqual(await fs.readFile(target),bytes);
 assert.equal(copied.data.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await fs.lstat(target)).isSymbolicLink(),false);assert.equal((await fs.stat(target)).nlink,1);
 assert.deepEqual(await fs.readFile(origin),bytes);
 assert.equal((await f.call('resultado_importar',{origen:origin,conversacion:id})).code,'FILE_EXISTS');
 const item=await f.call('conversacion_leer',{id});
 assert.equal(item.data.conversacion.resultados[0].archivo,target);
 assert.equal(item.data.conversacion.resultados[0].sha256,copied.data.sha256);
});
test('preferir una ruta no concede permisos y excluidos/enlaces se rechazan',async t=>{
 const f=await setup(t);
 await f.call('destinos_configurar',{revision:0,destinos:{carpeta:path.join(f.root,'Sin permiso')}});
 assert.equal((await f.call('crear',{ruta:'no.txt',contenido:'no'})).code,'FOLDER_NOT_AUTHORIZED');
 const target=path.join(f.folder,'ajeno.txt');await fs.writeFile(target,'Conservar.');
 assert.equal((await f.call('crear',{ruta:'ajeno.txt',destino:target,contenido:'No sustituir.'})).code,'FILE_EXISTS');
 assert.equal(await fs.readFile(target,'utf8'),'Conservar.');
 assert.equal((await f.call('destino_resolver',{nombre:'../escapar.txt'})).code,'INVALID_DESTINATIONS');
 const origin=path.join(f.folder,'original.bin');await fs.writeFile(origin,Buffer.from([0,255,127]));
 const linked=path.join(f.folder,'enlace.bin');await fs.link(origin,linked);
 assert.equal((await f.call('resultado_importar',{origen:linked,destino:path.join(f.folder,'copia.bin')})).code,'UNSAFE_PATH');
 await assert.rejects(fs.stat(path.join(f.folder,'copia.bin')),{code:'ENOENT'});
});
test('usuario nuevo: almacén junto a Base, sin exponer Motor, Runtime ni Base',async t=>{
 const f=await agentFixture(t);
 const layout={...f.layout,userDataDirectory:path.join(f.mind,'Conversaciones')};
 const session=await f.open({layout});
 await fs.mkdir(path.join(f.mind,'Runtime'));
 const workspace=createWorkspaceAccess(session,{paths:[],cwd:f.mind});
 const conn=connection();await workspace.initialize(conn);
 const tools=createAgentTools({session:workspace.session,connection:conn});
 const plan=await tools.call('destinos_consultar',{},{});
 assert.equal(plan.predeterminado,layout.userDataDirectory);
 const created=await tools.call('conversacion_guardar',{titulo:'Primera conversación',importante:'Decisión inicial.'},{});
 assert.equal(path.dirname(created.conversacion.archivo),layout.userDataDirectory);
 const file=await tools.call('crear',{ruta:'informe.md',contenido:'Entrega inicial.'},{});
 assert.equal(file.ruta_absoluta,path.join(layout.userDataDirectory,'informe.md'));
 for(const internal of [f.mind,path.join(f.mind,'Base'),path.join(f.mind,'Runtime')]){
   await assert.rejects(session.motor.authorizeFolder(internal),{code:'FOLDER_OVERLAPS_INTERNAL'});
 }
 const another=await f.open({layout});
 const otherWorkspace=createWorkspaceAccess(another,{paths:[],cwd:f.mind});await otherWorkspace.initialize(conn);
 const otherTools=createAgentTools({session:otherWorkspace.session,connection:conn});
 const found=await otherTools.call('conversaciones_buscar',{modo:'palabras',consulta:'Primera'},{});
 assert.equal(found.conversaciones[0].id,created.conversacion.id);
});
test('un proyecto puede usar otro almacén autorizado fuera de la raíz abierta sin ampliar permisos',async t=>{
 const f=await setup(t);
 const elsewhere=path.join(f.root,'Destino elegido');await fs.mkdir(elsewhere);
 const external=await f.session.motor.authorizeFolder(elsewhere);
 await f.session.policy.set(external.id,['encontrar','leer','escribir','organizar'],{channel:'administracion-local'});
 await f.session.motor.configureWorkDestinations({project:'Brisa',destinations:{carpeta:elsewhere},expectedRevision:0});
 const workspace=createWorkspaceAccess(f.session,{paths:[f.folder]});const conn=connection();await workspace.initialize(conn);
 const tools=createAgentTools({session:workspace.session,connection:conn});
 const output=await tools.call('crear',{ruta:'nuevo.txt',contenido:'Elegido.',proyecto:'Brisa'},{});
 assert.equal(output.ruta_absoluta,path.join(elsewhere,'nuevo.txt'));
 await f.session.policy.set(external.id,['encontrar'],{channel:'administracion-local'});
 await assert.rejects(tools.call('crear',{ruta:'otro.txt',contenido:'No.',proyecto:'Brisa'},{}),{code:'ACCESS_NOT_GRANTED'});
});

test('abrir el cliente en la raíz de Mind abre su almacén Conversaciones, no la instalación',async t=>{
 const f=await agentFixture(t);const layout={...f.layout,userDataDirectory:path.join(f.mind,'Conversaciones')};
 const session=await f.open({layout});
 const workspace=createWorkspaceAccess(session,{paths:[],cwd:f.mind});
 await workspace.initialize(connection());
 assert.equal(workspace.active(),true);
 const open=await workspace.session.motor.listAuthorizedFolders();
 assert.deepEqual(open.map(folder=>folder.path),[await fs.realpath(layout.userDataDirectory)]);
});

test('el almacén predeterminado conserva el flujo manual fuera de un proyecto abierto',async t=>{
 const f=await agentFixture(t);const layout={...f.layout,userDataDirectory:path.join(f.mind,'Conversaciones')};
 const session=await f.open({layout});
 // Directorio inicial que no es una carpeta de trabajo válida: ningún proyecto queda abierto.
 // (La raíz de Mind ya no sirve para esto: r3 la sustituye por Conversaciones.)
 const workspace=createWorkspaceAccess(session,{paths:[],cwd:path.join(f.root,'inexistente')});
 const conn=connection({onElicit:()=>({action:'accept',content:{acceso:'completo'}})});
 await workspace.initialize(conn);
 assert.equal(workspace.active(),false);
 await workspace.beforeCall('solicitar_acceso',{ruta:f.folder,acceso:'completo'});
 const tools=createAgentTools({session:workspace.session,connection:conn});
 const accepted=await tools.call('solicitar_acceso',{ruta:f.folder,acceso:'completo'},{});
 assert.equal(accepted.estado,'autorizado');
 const created=await tools.call('crear',{ruta:'otra.txt',contenido:'Dato ficticio.',destino:path.join(f.folder,'otra.txt')},{});
 assert.equal(created.ruta_absoluta,path.join(f.folder,'otra.txt'));
 const fallback=await tools.call('crear',{ruta:'predeterminado.txt',contenido:'Dato ficticio.'},{});
 assert.equal(fallback.ruta_absoluta,path.join(layout.userDataDirectory,'predeterminado.txt'));
});

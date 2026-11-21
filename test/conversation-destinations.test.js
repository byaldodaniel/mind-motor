import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {agentFixture,connection} from './helpers/agent-fixture.js';

async function setup(t){
  const f=await agentFixture(t);const session=await f.open();
  const folder=await session.motor.authorizeFolder(f.folder);
  await session.policy.set(folder.id,['encontrar','leer','escribir','organizar'],{channel:'administracion-local'});
  await session.policy.setContinuity(['leer','registrar'],{channel:'administracion-local'});
  return {...f,session,call:f.agent(session,connection()),authorizedFolder:folder};
}
test('destino predeterminado, archivo real y continuidad con otro agente',async t=>{
 const f=await setup(t);
 const saved=await f.call('conversacion_guardar',{titulo:'Ensayo Brisa',importante:'Aprobadas 23 cajas. Pendiente fecha.'});
 assert.equal(saved.isError,false,saved.text);assert.equal(saved.data.estado,'registrada');
 const item=saved.data.conversacion;assert.equal(path.dirname(item.archivo),path.join(f.folder,'Conversaciones'));
 assert.match(await fs.readFile(item.archivo,'utf8'),/23 cajas/);
 const other=await f.open();const call=f.agent(other,connection({clientInfo:{name:'Segundo agente',version:'1'}}));
 const found=await call('conversaciones_buscar',{modo:'palabras',consulta:'Brisa'});
 assert.equal(found.data.conversaciones[0].id,item.id);
 assert.equal((await call('conversacion_leer',{id:item.id})).data.conversacion.archivo,item.archivo);
 const update=await call('conversacion_guardar',{id:item.id,revision:1,importante:'Corregido: 31 cajas. Fecha viernes.'});
 assert.equal(update.data.estado,'actualizada',update.text);
 assert.equal(update.data.conversacion.archivo,item.archivo);
 const actual=await fs.readFile(item.archivo,'utf8');assert.match(actual,/31 cajas/);assert.doesNotMatch(actual,/23 cajas/);
});
test('destino elegido, preferencia persistente y archivos ajenos preservados',async t=>{
 const f=await setup(t);
 const target=path.join(f.folder,'Escritorio ficticio','mi resumen.md');
 const save=await f.call('conversacion_guardar',{titulo:'Personal',importante:'Acuerdo elegido.',destino:target});
 assert.equal(save.data.estado,'registrada',save.text);assert.equal(save.data.conversacion.archivo,target);
 await fs.appendFile(target,'\nNota añadida por el usuario.\n');
 const fail=await f.call('conversacion_guardar',{id:save.data.conversacion.id,revision:1,importante:'No reemplazar.'});
 assert.equal(fail.code,'CONVERSATION_FILE_CONFLICT');assert.match(await fs.readFile(target,'utf8'),/Nota añadida/);
 const directory=path.join(f.folder,'Memorias elegidas');
 assert.equal((await f.call('conversacion_configurar',{revision:0,preferencias:{modo:'esencial',carpeta_destino:directory}})).isError,false);
 const next=await f.call('conversacion_guardar',{titulo:'Nueva',importante:'Nuevo acuerdo.'});
 assert.equal(next.data.estado,'registrada',next.text);assert.equal(path.dirname(next.data.conversacion.archivo),directory);
 const foreign=path.join(f.folder,'ajeno.md');await fs.writeFile(foreign,'Contenido ajeno');
 assert.equal((await f.call('conversacion_guardar',{titulo:'Otra',importante:'No sustituir.',destino:foreign})).code,'CONVERSATION_FILE_CONFLICT');
 assert.equal(await fs.readFile(foreign,'utf8'),'Contenido ajeno');
});
test('manual no crea carpeta; un destino externo no concede permisos',async t=>{
 const f=await setup(t);
 await f.call('conversacion_configurar',{revision:0,preferencias:{modo:'manual'}});
 assert.equal((await f.call('conversacion_guardar',{titulo:'No',importante:'No guardar.'})).code,'CONVERSATION_MANUAL_ONLY');
 await assert.rejects(fs.stat(path.join(f.folder,'Conversaciones')),{code:'ENOENT'});
 assert.equal((await f.call('conversacion_guardar',{titulo:'No',importante:'No guardar.',solicitado:true,destino:path.join(f.root,'fuera.md')})).code,'FOLDER_NOT_AUTHORIZED');
 assert.equal((await f.session.motor.listContinuityIds()).length,0);
});

test('completa un Markdown ausente tras retomar, sin otro registro ni sobrescritura', async t => {
  const f = await setup(t);
  const target = path.join(f.folder, 'Pendiente.md');
  const faultyCall = f.agent({
    ...f.session,
    motor: {
      ...f.session.motor,
      async createTextFile() {
        throw Object.assign(new Error('Fallo ficticio de Markdown'), { code: 'CREATE_FAILED' });
      },
    },
  }, connection());
  const saved = await faultyCall('conversacion_guardar', {
    titulo: 'Nota ficticia', importante: 'Conservar este contenido.', destino: target,
  });
  assert.equal(saved.data.estado, 'pendiente_archivo', saved.text);
  const id = saved.data.conversacion.id;
  assert.deepEqual(saved.data.reintento, { id, revision: 1 });
  const record = path.join(f.layout.baseDirectory, 'continuity-' + id + '.json');
  const originalRecord = await fs.readFile(record);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await f.session.close();

  const reopened = await f.open();
  const call = f.agent(reopened, connection());
  await fs.writeFile(target, 'Archivo de otra persona', { flag: 'wx' });
  const conflict = await call('conversacion_guardar', saved.data.reintento);
  assert.equal(conflict.code, 'CONVERSATION_FILE_CONFLICT', conflict.text);
  assert.equal(await fs.readFile(target, 'utf8'), 'Archivo de otra persona');
  await fs.unlink(target);

  const retries = await Promise.all([
    call('conversacion_guardar', saved.data.reintento),
    call('conversacion_guardar', saved.data.reintento),
  ]);
  for (const result of retries) {
    assert.equal(result.data.estado, 'archivo_completado', result.text);
    assert.deepEqual(result.data.conversacion, saved.data.conversacion);
  }
  const markdown = await fs.readFile(target, 'utf8');
  assert.equal(markdown, '<!-- mind-conversation:' + id + ' revision:1 -->\n# Nota ficticia\n\nConservar este contenido.\n');
  assert.equal((await call('conversacion_guardar', saved.data.reintento)).data.estado, 'archivo_completado');
  assert.equal(await fs.readFile(target, 'utf8'), markdown);
  assert.deepEqual(await fs.readFile(record), originalRecord);
  assert.deepEqual(await reopened.motor.listContinuityIds(), [id]);
});

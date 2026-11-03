import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentFixture, connection, scriptedPrompt } from './helpers/agent-fixture.js';
import { authorizeConsole } from '../src/console.js';
import { createAgentTools } from '../src/agent-tools.js';
import { install, uninstall, status } from '../src/commands/programador.js';
import { createSystemScheduler } from '../src/automations/system.js';

const grant = (acceso) => ({ action: 'accept', content: { acceso } });

async function authorized(t, { observe = false } = {}) {
  const fixture = await agentFixture(t, { prefix: '.mind-functions-test-', observe });
  const session = await fixture.open();
  const queue = [grant('completo')];
  const conn = connection({ onElicit: () => queue.shift() ?? { action: 'decline' } });
  const call = fixture.agent(session, conn);
  const granted = await call('solicitar_acceso', { ruta: fixture.folder, acceso: 'completo' });
  await session.ensureIndex(granted.data.carpeta.id);
  return { ...fixture, session, call, queue, conn, folderId: granted.data.carpeta.id };
}

const template = (folderId, ruta, activacion = { tipo: 'manual' }) => ({
  nombre: 'Nota ficticia', ejecutor: 'plantilla-texto',
  parametros: { destino: { carpeta: folderId, ruta }, plantilla: 'Generado por {funcion}' }, activacion,
});

test('el agente crea, ejecuta, modifica y retira funciones; los datos nunca son código', async (t) => {
  const { call, folder, folderId } = await authorized(t);
  const listed = (await call('funciones')).data;
  const names = listed.ejecutores.map((item) => item.nombre);
  for (const name of ['indexar', 'plantilla-texto', 'respaldo', 'indice-csv']) assert.ok(names.includes(name), name);
  assert.match(listed.programador_del_sistema, /no instalado/);

  assert.equal((await call('crear_funcion', { id: 'malicia', definicion: { ejecutor: 'eval', parametros: { codigo: 'process.exit()' } } })).code, 'EXECUTOR_NOT_FOUND');
  const created = await call('crear_funcion', { id: 'nota', definicion: template(folderId, 'nota.txt') });
  assert.equal(created.data.estado, 'creada', JSON.stringify(created.data));
  const run = await call('ejecutar_funcion', { id: 'nota' });
  assert.equal(run.data.estado, 'completada', JSON.stringify(run.data));
  assert.equal(await fs.readFile(path.join(folder, 'nota.txt'), 'utf8'), 'Generado por nota');
  assert.equal((await call('ejecutar_funcion', { id: 'nota' })).data.codigo, 'FILE_EXISTS', 'nunca sobrescribe');

  await call('modificar_funcion', { id: 'nota', definicion: template(folderId, 'otra.txt') });
  assert.equal((await call('ejecutar_funcion', { id: 'nota' })).data.estado, 'completada');
  assert.ok(await fs.access(path.join(folder, 'otra.txt')).then(() => true));
  const history = (await call('historial_funcion', { id: 'nota' })).data.ejecuciones;
  assert.equal(history.length, 3);
  assert.ok(!JSON.stringify(history).includes('Generado por'), 'el historial no guarda contenido');
  assert.equal((await call('retirar_funcion', { id: 'nota' })).data.estado, 'retirada');
  const gone = await call('ejecutar_funcion', { id: 'nota' });
  assert.equal(gone.code ?? gone.data.codigo, 'FUNCTION_NOT_FOUND', JSON.stringify(gone.data));

  // Sin permiso de escritura, la función no escribe aunque exista.
  await call('crear_funcion', { id: 'sin-permiso', definicion: template(folderId, 'no.txt') });
  await call('retirar_acceso', { permisos: ['escribir', 'organizar'] });
  assert.equal((await call('ejecutar_funcion', { id: 'sin-permiso' })).data.codigo, 'ACCESS_NOT_GRANTED');
  await assert.rejects(fs.access(path.join(folder, 'no.txt')));
});

test('activar una función automática exige la autorización del usuario; sin formulario, la consola', async (t) => {
  const { call, queue, session, folderId } = await authorized(t);
  await call('crear_funcion', { id: 'cada-hora', definicion: template(folderId, 'hora-{fecha}.txt', { tipo: 'horario', frecuencia: 'intervalo', minutos: 60 }) });
  queue.push({ action: 'decline' });
  assert.equal((await call('activar_funcion', { id: 'cada-hora' })).data.estado, 'rechazado');
  queue.push({ action: 'accept', content: { activar: true } });
  const activated = await call('activar_funcion', { id: 'cada-hora', motivo: 'resumen horario' });
  assert.equal(activated.data.estado, 'activada', JSON.stringify(activated.data));
  assert.equal((await call('desactivar_funcion', { id: 'cada-hora' })).data.estado, 'desactivada');

  // Cliente sin formularios: queda pendiente y el usuario decide en la consola.
  const quiet = createAgentTools({ session, connection: connection() });
  const pending = await quiet.call('activar_funcion', { id: 'cada-hora' }, {});
  assert.equal(pending.estado, 'pendiente');
  assert.equal(await authorizeConsole({ session, prompt: scriptedPrompt('s') }), 1);
  assert.match(JSON.stringify((await call('funciones')).data.funciones), /cada-hora/);
});

test('función por evento con índice CSV: se ejecuta sola en la sesión al cambiar la carpeta', async (t) => {
  const { call, queue, folder, folderId } = await authorized(t, { observe: true });
  const index = await call('crear_indice', { nombre: 'Lista', campos: ['ruta'], ruta_csv: 'lista.csv' });
  assert.equal(index.data.estado, 'creado', JSON.stringify(index.data));
  const defined = await call('crear_funcion', {
    id: 'lista-viva', definicion: { nombre: 'Lista viva', ejecutor: 'indice-csv', parametros: { indice: index.data.id }, activacion: { tipo: 'evento', carpeta: folderId, espera_segundos: 5 } },
  });
  assert.equal(defined.data.estado, 'creada', JSON.stringify(defined.data));
  queue.push({ action: 'accept', content: { activar: true } });
  const activated = await call('activar_funcion', { id: 'lista-viva' });
  assert.equal(activated.data.estado, 'activada', JSON.stringify(activated.data));
  await fs.writeFile(path.join(folder, 'evento.txt'), 'x');
  const deadline = Date.now() + 30_000;
  let history = [];
  while (Date.now() < deadline) {
    history = (await call('historial_funcion', { id: 'lista-viva' })).data.ejecuciones;
    if (history.some((item) => item.origen === 'evento' && item.estado === 'completada')) break;
    await delay(300);
  }
  assert.ok(history.some((item) => item.origen === 'evento' && item.estado === 'completada'), JSON.stringify(history));
  assert.match(await fs.readFile(path.join(folder, 'lista.csv'), 'utf8'), /evento\.txt/);
});

test('programador del sistema: instalar exige confirmación, se describe, informa y se retira', async (t) => {
  const { layout, mind } = await authorized(t);
  await fs.writeFile(path.join(mind, process.platform === 'win32' ? 'mind.cmd' : 'mind'), '');
  let crontab = '';
  const run = async (program, args, { input } = {}) => {
    if (args.includes('-r')) {
      crontab = '';
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('-l')) return crontab ? { code: 0, stdout: crontab, stderr: '' } : { code: 1, stdout: '', stderr: 'no crontab for user' };
    if (args.includes('-')) {
      crontab = input;
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const scheduler = createSystemScheduler({ platform: 'linux', run, programs: { crontab: '/usr/bin/crontab', systemctl: '/no/existe' } });
  const declined = scriptedPrompt('n');
  assert.equal((await install({ layout, prompt: declined, scheduler })).status, 'cancelado');
  assert.equal(crontab, '');
  assert.ok(declined.lines.some((line) => line.includes('programadas')));

  assert.equal((await install({ layout, prompt: scriptedPrompt('s'), scheduler })).status, 'instalado');
  assert.match(crontab, /programadas/);
  assert.equal((await status({ layout, scheduler })).instalado, true);
  assert.equal((await uninstall({ layout, scheduler })).status, 'desinstalado');
  assert.doesNotMatch(crontab, /programadas/);
  assert.equal((await status({ layout, scheduler })).instalado, false);
});

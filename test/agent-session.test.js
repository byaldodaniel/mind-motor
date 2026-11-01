import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from '../src/session.js';
import { createAgentTools } from '../src/agent-tools.js';
import { toolResult, toolError } from '../src/mcp-server.js';
import { authorizeConsole } from '../src/console.js';

const motorDirectory = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const development = path.dirname(motorDirectory);
const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3';

/** Conexión simulada: onElicit hace de interfaz del cliente que pregunta al usuario. */
function connection({ onElicit = null, clientInfo = { name: 'cliente-de-prueba', version: '1.0' } } = {}) {
  const asked = [];
  return {
    asked,
    protocolVersion: '2025-11-25',
    clientInfo,
    supportsFormElicitation: () => onElicit !== null,
    async request(method, params) {
      asked.push({ method, params });
      return onElicit(params);
    },
  };
}

const accept = (content) => () => ({ action: 'accept', content: { autorizar: true, ...content } });

async function fixture(t, { observe = false } = {}) {
  const root = await fs.mkdtemp(path.join(development, '.mind-agent-session-test-'));
  const sessions = [];
  t.after(async () => {
    await Promise.allSettled(sessions.map((session) => session.close()));
    assert.equal(path.dirname(root), development);
    assert.ok(path.basename(root).startsWith('.mind-agent-session-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const mind = path.join(root, 'Mind');
  await fs.mkdir(mind);
  const folder = path.join(root, 'Información ficticia');
  await fs.mkdir(path.join(folder, 'Proyectos'), { recursive: true });
  await fs.writeFile(path.join(folder, 'Proyectos', 'presupuesto.md'), '# Presupuesto ficticio\nTotal: 100\n');
  await fs.writeFile(path.join(folder, 'notas.txt'), 'Notas ficticias\n');
  const layout = {
    product: true, manifest: null, root: mind, motorDirectory,
    baseDirectory: path.join(mind, 'Base'), pythonExecutable, protectedDirectories: [mind],
  };
  async function open(options = {}) {
    const session = await openSession({ layout, motorVersion: '0.0.0-prueba', observe, ...options });
    sessions.push(session);
    await session.start();
    return session;
  }
  /** Llama a una herramienta como lo haría el servidor MCP. */
  function agent(session, conn) {
    const tools = createAgentTools({ session, connection: conn });
    return async (name, args = {}) => {
      try {
        const result = toolResult(await tools.call(name, args, {}));
        return { data: result.structuredContent, text: result.content[0].text, isError: false };
      } catch (error) {
        const result = toolError(error);
        return { data: result.structuredContent, text: result.content[0].text, isError: true, code: result.structuredContent.error.codigo };
      }
    };
  }
  return { root, mind, folder: await fs.realpath(folder), layout, open, agent };
}

test('el usuario decide en el formulario del cliente; el agente no puede ampliar lo concedido', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  const conn = connection({ onElicit: accept({ leer: true, escribir: false }) });
  const call = agent(session, conn);
  assert.deepEqual((await call('estado')).data.carpetas, []);

  const granted = await call('solicitar_acceso', { ruta: folder, permisos: ['leer', 'escribir'], motivo: 'Resumir\nel presupuesto' });
  assert.equal(granted.data.estado, 'autorizado');
  assert.deepEqual(granted.data.carpeta.permisos, ['encontrar', 'leer']);
  assert.equal(granted.data.indice.estado, 'vigente');
  const form = conn.asked[0].params;
  assert.equal(form.mode, 'form');
  assert.match(form.message, new RegExp(folder.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.match(form.message, /Resumir el presupuesto/);
  assert.equal(form.requestedSchema.properties.autorizar.default, false);

  const found = await call('buscar', { consulta: 'presupuesto' });
  assert.equal(found.data.total, 1);
  assert.equal(found.data.resultados[0].ruta, 'Proyectos/presupuesto.md');
  assert.equal(found.data.resultados[0].ruta_absoluta, path.join(folder, 'Proyectos', 'presupuesto.md'));
  const read = await call('leer', { ruta: 'Proyectos/presupuesto.md' });
  assert.match(read.text, /Total: 100/);
  // Defecto detectado con Claude Code real: el cliente puede mostrar solo los datos estructurados.
  assert.equal(read.data.contenido, '# Presupuesto ficticio\nTotal: 100\n');
  assert.match(read.data.version, /^sha256:[0-9a-f]{64}$/);

  const denied = await call('crear', { ruta: 'nuevo.txt', contenido: 'x' });
  assert.equal(denied.code, 'ACCESS_NOT_GRANTED');
  await assert.rejects(fs.access(path.join(folder, 'nuevo.txt')));
  // Pedir de nuevo lo ya concedido no vuelve a preguntar.
  assert.equal((await call('solicitar_acceso', { ruta: folder, permisos: ['leer'] })).data.estado, 'ya-autorizado');
  assert.equal(conn.asked.length, 1);
});

test('rechazar, cancelar o no marcar la casilla no registra nada; cancelar deja la solicitud para la consola', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  for (const [answer, expected, pending] of [
    [{ action: 'decline' }, 'rechazado', 0],
    [{ action: 'accept', content: { autorizar: false, leer: true } }, 'rechazado', 0],
    [{ action: 'cancel' }, 'pendiente', 1],
  ]) {
    const call = agent(session, connection({ onElicit: () => answer }));
    const result = await call('solicitar_acceso', { ruta: folder, permisos: ['leer'] });
    assert.equal(result.data.estado, expected);
    if (expected === 'pendiente') assert.match(result.data.instrucciones, /se canceló/);
    assert.equal((await session.requests.list()).length, pending);
  }
  assert.deepEqual(await session.motor.listAuthorizedFolders(), []);
});

test('sin formularios, la solicitud queda pendiente hasta que el usuario la aprueba en la consola', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  const call = agent(session, connection());
  const pending = await call('solicitar_acceso', { ruta: folder, permisos: ['leer'], motivo: 'Buscar actas' });
  assert.equal(pending.data.estado, 'pendiente');
  assert.equal((await call('leer', { carpeta: folder, ruta: 'notas.txt' })).code, 'FOLDER_NOT_AUTHORIZED');
  assert.equal((await call('estado')).data.solicitudes_pendientes.length, 1);

  const answers = ['s', 's'];
  const lines = [];
  const prompt = {
    write: (line = '') => lines.push(line),
    ask: async () => answers.shift(),
    yes: async () => ['s'].includes(answers.shift()),
  };
  assert.equal(await authorizeConsole({ session, prompt }), 1);
  assert.ok(lines.some((line) => line.includes(folder)));
  assert.ok(lines.some((line) => line.includes('Buscar actas')));
  assert.equal((await call('estado')).data.solicitudes_pendientes.length, 0);
  assert.match((await call('leer', { ruta: 'notas.txt' })).text, /Notas ficticias/);
});

test('se rechazan ubicaciones demasiado amplias o internas antes de preguntar al usuario', async (t) => {
  const { mind, root, open, agent } = await fixture(t);
  const session = await open();
  const conn = connection({ onElicit: accept({}) });
  const call = agent(session, conn);
  const inside = path.join(mind, 'Datos');
  await fs.mkdir(inside);
  for (const [ruta, code] of [
    ['relativa/carpeta', 'INVALID_FOLDER_PATH'],
    [path.join(root, 'no-existe'), 'FOLDER_UNAVAILABLE'],
    [path.parse(root).root, 'FOLDER_TOO_BROAD'],
    [os.homedir(), 'FOLDER_TOO_BROAD'],
    [mind, 'FOLDER_OVERLAPS_INTERNAL'],
    [inside, 'FOLDER_OVERLAPS_INTERNAL'],
    [path.join(mind, 'Base'), 'FOLDER_OVERLAPS_INTERNAL'],
    [motorDirectory, 'FOLDER_OVERLAPS_INTERNAL'],
  ]) {
    assert.equal((await call('solicitar_acceso', { ruta, permisos: ['leer'] })).code, code, ruta);
  }
  assert.equal(conn.asked.length, 0);
  // Tampoco por la vía administrativa: la carpeta de Mind está protegida en el registro.
  await assert.rejects(session.motor.authorizeFolder(inside), { code: 'FOLDER_OVERLAPS_INTERNAL' });
});

test('encontrar no permite leer; retirar y volver a autorizar no reactiva permisos anteriores', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  const call = agent(session, connection({ onElicit: accept({}) }));
  const granted = await call('solicitar_acceso', { ruta: folder, permisos: ['encontrar'] });
  assert.deepEqual(granted.data.carpeta.permisos, ['encontrar']);
  assert.equal((await call('explorar', { profundidad: 2 })).data.total, 3);
  assert.equal((await call('leer', { ruta: 'notas.txt' })).code, 'ACCESS_NOT_GRANTED');
  assert.equal((await call('editar', { ruta: 'notas.txt', ediciones: [{ buscar: 'Notas', reemplazar: 'X' }] })).code, 'ACCESS_NOT_GRANTED');

  const id = granted.data.carpeta.id;
  assert.equal((await call('retirar_acceso', { carpeta: id, todo: true })).data.estado, 'retirada');
  assert.equal(await session.motor.readFolderIndex(id).catch((error) => error.code), 'FOLDER_NOT_AUTHORIZED');
  // El usuario vuelve a registrar la carpeta por la vía administrativa, sin decidir permisos.
  await session.motor.authorizeFolder(folder);
  const status = await call('estado');
  assert.deepEqual(status.data.carpetas[0].permisos, []);
  assert.equal((await call('buscar', { consulta: 'notas' })).code, 'ACCESS_NOT_GRANTED');
});

test('reducir permisos conserva el resto; los parámetros desconocidos se rechazan', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  const call = agent(session, connection({ onElicit: accept({ leer: true, escribir: true }) }));
  const id = (await call('solicitar_acceso', { ruta: folder, permisos: ['leer', 'escribir'] })).data.carpeta.id;
  assert.deepEqual((await call('retirar_acceso', { carpeta: id, permisos: ['escribir'] })).data.permisos, ['encontrar', 'leer']);
  assert.equal((await call('crear', { ruta: 'a.txt', contenido: 'x' })).code, 'ACCESS_NOT_GRANTED');
  assert.match((await call('leer', { ruta: 'notas.txt' })).text, /Notas/);
  assert.equal((await call('leer', { ruta: 'notas.txt', permiso: 'falso' })).code, 'INVALID_ARGUMENTS');
  assert.equal((await call('leer', { carpeta: 'f'.repeat(64), ruta: 'notas.txt' })).code, 'FOLDER_NOT_AUTHORIZED');
});

test('crear, modificar y editar con control de versiones; nunca se sobrescribe a ciegas', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  const call = agent(session, connection({ onElicit: accept({ leer: true, escribir: true }) }));
  await call('solicitar_acceso', { ruta: folder, permisos: ['leer', 'escribir'] });

  const created = await call('crear', { ruta: 'Proyectos/acta.md', contenido: 'Acta ficticia\nPendiente: revisar\nPendiente: enviar\n' });
  assert.equal(created.data.estado, 'creado');
  assert.equal(created.data.indice, 'updated');
  assert.equal((await call('crear', { ruta: 'Proyectos/acta.md', contenido: 'otra' })).code, 'FILE_EXISTS');
  assert.equal((await call('buscar', { consulta: 'acta' })).data.total, 1);

  const ambiguous = await call('editar', { ruta: 'Proyectos/acta.md', ediciones: [{ buscar: 'Pendiente', reemplazar: 'Hecho' }] });
  assert.equal(ambiguous.code, 'EDIT_AMBIGUOUS');
  assert.equal((await call('editar', { ruta: 'Proyectos/acta.md', ediciones: [{ buscar: 'inexistente', reemplazar: 'x' }] })).code, 'EDIT_NOT_FOUND');
  const edited = await call('editar', { ruta: 'Proyectos/acta.md', ediciones: [
    { buscar: 'Pendiente', reemplazar: 'Hecho', todas: true }, { buscar: 'Acta ficticia', reemplazar: 'Acta ficticia revisada' },
  ] });
  assert.equal(edited.data.estado, 'modificado');
  assert.equal(await fs.readFile(path.join(folder, 'Proyectos', 'acta.md'), 'utf8'), 'Acta ficticia revisada\nHecho: revisar\nHecho: enviar\n');

  const read = await call('leer', { ruta: 'Proyectos/acta.md', desde_linea: 2, lineas: 1 });
  assert.match(read.text, /--- contenido ---\nHecho: revisar$/);
  // Un cambio externo después de leer invalida la versión: Mind no escribe.
  await fs.writeFile(path.join(folder, 'Proyectos', 'acta.md'), 'Cambio externo ficticio\n');
  assert.equal((await call('modificar', { ruta: 'Proyectos/acta.md', version: read.data.version, contenido: 'mío' })).code, 'VERSION_CONFLICT');
  assert.equal((await call('editar', { ruta: 'Proyectos/acta.md', version: read.data.version, ediciones: [{ buscar: 'Cambio', reemplazar: 'X' }] })).code, 'VERSION_CONFLICT');
  assert.equal(await fs.readFile(path.join(folder, 'Proyectos', 'acta.md'), 'utf8'), 'Cambio externo ficticio\n');
  const current = await call('leer', { ruta: 'Proyectos/acta.md' });
  const modified = await call('modificar', { ruta: 'Proyectos/acta.md', version: current.data.version, contenido: 'Versión final ficticia\n' });
  assert.equal(modified.data.version_anterior, current.data.version);
  assert.equal(await fs.readFile(path.join(folder, 'Proyectos', 'acta.md'), 'utf8'), 'Versión final ficticia\n');
  const audit = await fs.readFile(path.join(session.motor.baseDirectory, 'auditoria.jsonl'), 'utf8');
  assert.match(audit, /"evento":"archivo-modificado"/);
  assert.doesNotMatch(audit, /Versión final ficticia/);
});

test('continuidad: permiso propio, origen fijado por Mind y continuación desde otra sesión y otra Base', async (t) => {
  const { root, open, agent, layout } = await fixture(t);
  const first = await open();
  const writer = agent(first, connection({ onElicit: () => ({ action: 'accept', content: { leer: true, registrar: true } }) }));
  assert.equal((await writer('continuidad_registrar', { contenido: 'x' })).code, 'ACCESS_NOT_GRANTED');
  assert.equal((await writer('solicitar_acceso', { continuidad: ['leer', 'registrar'] })).data.estado, 'autorizado');
  const decision = await writer('continuidad_registrar', {
    tipo: 'decisión', contenido: { texto: 'Usar el presupuesto revisado', motivo: 'acuerdo ficticio' },
    referencias: [{ ubicacion: 'Proyectos/presupuesto.md', relacion: 'fuente' }],
  });
  assert.equal(decision.data.registro.origen, 'cliente-de-prueba 1.0 (declarado por el cliente)');
  assert.equal((await writer('continuidad_registrar', { contenido: 'x', origen: 'otro' })).code, 'INVALID_ARGUMENTS');
  await writer('continuidad_registrar', { tipo: 'resultado', contenido: 'Resumen enviado', referencias: [{ registro: decision.data.registro.id, relacion: 'aplica' }] });
  await first.close();

  // Otra sesión y otro agente continúan el trabajo.
  const second = await open();
  const other = agent(second, connection({ clientInfo: { name: 'otro-agente', version: '2' } }));
  const found = await other('continuidad_consultar', { texto: 'presupuesto revisado' });
  assert.equal(found.data.total, 1);
  assert.equal(found.data.registros[0].tipo, 'decisión');
  const related = await other('continuidad_consultar', { tipo: 'resultado', relacionados: true });
  assert.equal(related.data.relacionados[0].id, decision.data.registro.id);
  const updated = await other('continuidad_actualizar', { id: decision.data.registro.id, revision: 1, contenido: { texto: 'Presupuesto revisado y aprobado' } });
  assert.equal(updated.data.registro.revision, 2);
  assert.equal(updated.data.registro.origen, 'cliente-de-prueba 1.0 (declarado por el cliente)');
  assert.equal((await other('continuidad_actualizar', { id: decision.data.registro.id, revision: 1, contenido: 'tarde' })).isError, true);
  const markdown = await other('continuidad_exportar', { formato: 'markdown' });
  assert.match(markdown.text, /Presupuesto revisado y aprobado/);
  assert.match(markdown.data.paquete, /Presupuesto revisado y aprobado/);
  const pack = (await other('continuidad_exportar', {})).text;

  // Importar en una Base distinta (otra instalación o aplicación).
  const otherLayout = { ...layout, baseDirectory: path.join(root, 'Otra Base') };
  const third = await openSession({ layout: otherLayout, motorVersion: '0.0.0-prueba', observe: false });
  t.after(() => third.close());
  await third.start();
  await third.policy.setContinuity(['leer', 'registrar'], { channel: 'administracion-local' });
  const importer = agent(third, connection());
  assert.equal((await importer('continuidad_importar', { paquete: pack })).data.importados.length, 2);
  assert.equal((await importer('continuidad_importar', { paquete: pack })).data.sin_cambios.length, 2);
  assert.equal((await importer('continuidad_consultar', { texto: 'aprobado' })).data.total, 1);
});

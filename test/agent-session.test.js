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

const accept = (acceso) => () => ({ action: 'accept', content: { acceso } });

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
  const conn = connection({ onElicit: accept('leer') });
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
  assert.match(form.message, /todo lo que contiene/);
  // Una sola elección (opción 1): se propone el nivel mínimo que cubre lo pedido.
  assert.deepEqual(Object.keys(form.requestedSchema.properties), ['acceso', 'excluir']);
  assert.deepEqual(form.requestedSchema.required, ['acceso']);
  assert.equal(form.requestedSchema.properties.acceso.default, 'completo');
  assert.deepEqual(form.requestedSchema.properties.acceso.oneOf.map((item) => item.const), ['encontrar', 'leer', 'completo']);

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
    [{ action: 'accept', content: { acceso: 'todo' } }, 'rechazado', 0],
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

  const answers = ['2', ''];
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
  const conn = connection({ onElicit: accept('encontrar') });
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
  const call = agent(session, connection({ onElicit: accept('encontrar') }));
  const granted = await call('solicitar_acceso', { ruta: folder, acceso: 'encontrar' });
  assert.deepEqual(granted.data.carpeta.permisos, ['encontrar']);
  assert.equal((await call('estado')).data.carpetas[0].acceso, 'encontrar');
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
  const call = agent(session, connection({ onElicit: accept('completo') }));
  const id = (await call('solicitar_acceso', { ruta: folder, permisos: ['leer', 'escribir'] })).data.carpeta.id;
  assert.equal((await call('estado')).data.carpetas[0].acceso, 'completo');
  assert.deepEqual((await call('retirar_acceso', { carpeta: id, permisos: ['escribir'] })).data.permisos, ['encontrar', 'leer', 'organizar']);
  assert.equal((await call('estado')).data.carpetas[0].acceso, 'personalizado');
  assert.equal((await call('crear', { ruta: 'a.txt', contenido: 'x' })).code, 'ACCESS_NOT_GRANTED');
  assert.match((await call('leer', { ruta: 'notas.txt' })).text, /Notas/);
  assert.equal((await call('leer', { ruta: 'notas.txt', permiso: 'falso' })).code, 'INVALID_ARGUMENTS');
  assert.equal((await call('leer', { carpeta: 'f'.repeat(64), ruta: 'notas.txt' })).code, 'FOLDER_NOT_AUTHORIZED');
});

test('crear, modificar y editar con control de versiones; nunca se sobrescribe a ciegas', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  const call = agent(session, connection({ onElicit: accept('completo') }));
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

test('exclusiones: el usuario las elige al autorizar; el agente puede añadir más, pero no volver a incluir', async (t) => {
  const { folder, open, agent } = await fixture(t);
  await fs.mkdir(path.join(folder, 'Privado'));
  await fs.writeFile(path.join(folder, 'Privado', 'claves.txt'), 'Datos privados ficticios\n');
  const session = await open();
  const conn = connection({ onElicit: () => ({ action: 'accept', content: { acceso: 'completo', excluir: 'Privado' } }) });
  const call = agent(session, conn);
  assert.equal(conn.asked.length, 0);
  const granted = await call('solicitar_acceso', { ruta: folder, acceso: 'completo' });
  assert.deepEqual(granted.data.carpeta.excluidas, ['Privado']);
  assert.equal(conn.asked[0].params.requestedSchema.properties.excluir.type, 'string');
  assert.equal((await call('buscar', { consulta: 'claves' })).data.total, 0);
  assert.equal((await call('explorar', { profundidad: 3 })).data.entradas.some((entry) => entry.ruta.startsWith('Privado')), false);
  assert.equal((await call('leer', { ruta: 'Privado/claves.txt' })).code, 'PATH_EXCLUDED');
  assert.equal((await call('crear', { ruta: 'Privado/nuevo.txt', contenido: 'x' })).code, 'PATH_EXCLUDED');
  // Excluir más reduce el acceso: no requiere confirmación.
  const more = await call('retirar_acceso', { carpeta: granted.data.carpeta.id, excluir: ['Proyectos'] });
  assert.deepEqual(more.data.excluidas, ['Privado', 'Proyectos']);
  assert.ok(more.data.entradas_retiradas_del_indice >= 2);
  assert.equal((await call('leer', { ruta: 'Proyectos/presupuesto.md' })).code, 'PATH_EXCLUDED');
  assert.deepEqual((await call('estado')).data.carpetas[0].excluidas, ['Privado', 'Proyectos']);
  // Volver a incluir no es una herramienta del agente.
  assert.equal((await call('retirar_acceso', { carpeta: granted.data.carpeta.id, incluir: ['Privado'] })).code, 'INVALID_ARGUMENTS');
  assert.equal(await fs.readFile(path.join(folder, 'Privado', 'claves.txt'), 'utf8'), 'Datos privados ficticios\n');
});

test('eliminados: rastro de solo metadatos y referencias de continuidad marcadas como rotas', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const session = await open();
  const call = agent(session, connection({ onElicit: (params) => (params.requestedSchema.properties.acceso
    ? { action: 'accept', content: { acceso: 'completo' } } : { action: 'accept', content: { leer: true, registrar: true } }) }));
  await call('solicitar_acceso', { ruta: folder, acceso: 'completo' });
  await call('solicitar_acceso', { continuidad: ['leer', 'registrar'] });
  assert.equal((await call('eliminados')).data.total, 0);
  const recorded = await call('continuidad_registrar', {
    tipo: 'decisión', contenido: 'Usar el presupuesto ficticio',
    referencias: [
      { ubicacion: 'Proyectos/presupuesto.md', relacion: 'fuente' },
      { ubicacion: path.join(folder, 'notas.txt') },
      { ubicacion: 'https://ejemplo.invalid/doc' },
    ],
  });
  assert.deepEqual(recorded.data.registro.referencias.map((item) => item.estado), ['existe', 'existe', undefined]);

  await fs.rm(path.join(folder, 'Proyectos', 'presupuesto.md'));
  const gone = await call('eliminados');
  assert.equal(gone.data.total, 1);
  const [entry] = gone.data.eliminados;
  assert.equal(entry.ruta, 'Proyectos/presupuesto.md');
  assert.equal(entry.por, 'externo');
  assert.equal(entry.bytes, Buffer.byteLength('# Presupuesto ficticio\nTotal: 100\n'));
  assert.ok(Number.isFinite(Date.parse(entry.eliminado)));
  const audit = JSON.stringify(gone.data);
  assert.doesNotMatch(audit, /Total: 100/);

  const query = await call('continuidad_consultar', { texto: 'presupuesto' });
  const references = query.data.registros[0].referencias;
  assert.equal(references[0].estado, 'eliminado');
  assert.equal(references[0].eliminado, entry.eliminado);
  assert.equal(references[1].estado, 'existe');
  assert.equal(references[2].estado, undefined);

  // Si vuelve a existir, deja de figurar como eliminado.
  await fs.writeFile(path.join(folder, 'Proyectos', 'presupuesto.md'), 'Nuevo presupuesto ficticio\n');
  assert.equal((await call('eliminados')).data.total, 0);
  assert.equal((await call('continuidad_consultar', { texto: 'presupuesto' })).data.registros[0].referencias[0].estado, 'existe');
});

test('con varias carpetas, la observación inicial las indexa todas respetando el límite de recorridos simultáneos', async (t) => {
  const { root, open, agent } = await fixture(t, { observe: true });
  const session = await open();
  const ids = [];
  for (let number = 1; number <= 5; number += 1) {
    const folder = path.join(root, `Carpeta ficticia ${number}`);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, `nota-${number}.txt`), `Nota ficticia ${number}\n`);
    const scope = await session.motor.authorizeFolder(folder);
    await session.policy.set(scope.id, ['encontrar'], { channel: 'administracion-local' });
    ids.push(scope.id);
  }
  await session.sync();
  const results = await Promise.all(ids.map((id) => session.ensureIndex(id)));
  assert.ok(results.every((result) => ['current', 'reconciled'].includes(result.status)), JSON.stringify(results));
  const call = agent(session, connection());
  const found = await call('buscar', { consulta: 'nota-' });
  assert.equal(found.data.total, 5);
  const status = await call('estado');
  assert.equal(status.data.mind.runtime.node, process.execPath);
});

test('leer extrae el texto de documentos de oficina sin abrirlos fuera del ámbito', async (t) => {
  const { folder, open, agent } = await fixture(t);
  const zlib = await import('node:zlib');
  // Construye un .docx mínimo (ZIP con un miembro deflate) solo con datos ficticios.
  const xml = Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Informe ficticio de gastos</w:t></w:r></w:p><w:p><w:r><w:t>Total: 312 EUR</w:t></w:r></w:p></w:body></w:document>');
  const name = Buffer.from('word/document.xml');
  const data = zlib.deflateRawSync(xml);
  const crc = zlib.crc32(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28);
  const offset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(offset, 16);
  await fs.writeFile(path.join(folder, 'Proyectos', 'gastos.docx'), Buffer.concat([local, name, data, central, name, end]));
  await fs.writeFile(path.join(folder, 'Proyectos', 'roto.docx'), 'no es un documento');
  const session = await open();
  const call = agent(session, connection({ onElicit: accept('leer') }));
  await call('solicitar_acceso', { ruta: folder, acceso: 'leer' });
  const read = await call('leer', { ruta: 'Proyectos/gastos.docx' });
  assert.equal(read.data.formato, 'docx');
  assert.equal(read.data.contenido, 'Informe ficticio de gastos\nTotal: 312 EUR');
  assert.equal(read.data.version, undefined);
  assert.match(read.data.nota, /no modifica este formato/);
  assert.equal((await call('leer', { ruta: 'Proyectos/roto.docx' })).code, 'DOCUMENT_INVALID');
  // Encontrar no basta para extraer contenido.
  await call('retirar_acceso', { carpeta: folder, permisos: ['leer'] });
  assert.equal((await call('leer', { ruta: 'Proyectos/gastos.docx' })).code, 'ACCESS_NOT_GRANTED');
});

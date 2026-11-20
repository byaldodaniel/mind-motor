import { MotorError } from './errors.js';

/**
 * Catálogo núcleo de Mind 1.0.5: diez herramientas visibles en lugar de las
 * cincuenta y cuatro operaciones de r3.
 *
 * Es solo una capa de presentación. Cada llamada se traduce a una o varias
 * operaciones internas y se ejecuta con su nombre original a través del mismo
 * despachador, de modo que la cola, los permisos, las confirmaciones del
 * usuario y los avisos de actualización no cambian. `mind` alcanza cualquier
 * operación interna por su nombre, y el modo `completo` devuelve el catálogo de
 * r3 a un cliente (reversibilidad).
 */

export const CATALOG_MODES = Object.freeze(['nucleo', 'completo']);

/** Modo efectivo: el que pide la conexión, si es válido; si no, el del entorno o `nucleo`. */
export function catalogMode(requested, env = process.env) {
  const value = String(requested ?? env.MIND_CATALOGO ?? '').trim().toLowerCase();
  return CATALOG_MODES.includes(value) ? value : 'nucleo';
}

export const CORE_INSTRUCTIONS = `Mind trabaja con los archivos que el usuario autoriza y conserva la continuidad entre sesiones y agentes.

1. Al empezar: si tienes un ID de conversación, "retomar" con ese id; trae memoria, pendientes, resultados y destinos en una llamada. Sin ID, "estado".
2. Antes de leer, "buscar". Pendientes o ideas: buscar en "marcas" (no leas los archivos). Un apartado de un documento: "leer" con "seccion" ("?" muestra el índice).
3. Escribir: "crear" nunca sobrescribe; "modificar" exige la version leída (o "ediciones" puntuales). "organizar" mueve, renombra, borra a la papelera y restaura.
4. Guardar lo importante: "guardar" crea (conversación nueva, registro de continuidad o resultado); "actualizar" cambia una conversación o registro existente con su id y revision. Crea archivos en los destinos que devuelve "retomar".
5. Permisos: la carpeta abierta en el cliente tiene acceso durante la sesión. Para otra, "acceso" solicitar con permisos mínimos. El usuario decide; nunca afirmes que autorizó algo. Las confirmaciones pendientes se resuelven con "mind autorizar" en la consola.
6. Lo demás (funciones, índices, respaldo, actualizaciones, traslados, preferencias): "mind" consulta y "mind_cambiar" modifica; operacion "ayuda" las lista.

Si una respuesta trae aviso_actualizacion, responde primero lo pedido y añade el aviso en una línea; aplica una actualización solo si el usuario lo pide. Informa con exactitud lo hecho y lo que falló.`;

const OPEN = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: true });
const FOLDER = { type: 'string', description: 'Id o ruta absoluta de una carpeta autorizada.' };
const RELATIVE = { type: 'string', description: 'Ruta relativa dentro de la carpeta, con "/".' };
const MORE = 'Acepta además los parámetros de la operación interna; mind {operacion:"ayuda", detalle:"<operación>"} los describe.';

// Cada herramienta núcleo elige una operación interna según `en` o `accion`.
// `renombrar` adapta los nombres de parámetros comunes a los de esa operación.
const ROUTES = Object.freeze({
  buscar: {
    selector: 'en',
    defecto: 'archivos',
    destinos: {
      archivos: { operacion: 'buscar' },
      marcas: { operacion: 'agrupar', renombrar: { consulta: 'etiqueta' } },
      conversaciones: { operacion: 'conversaciones_buscar' },
      continuidad: { operacion: 'continuidad_consultar', renombrar: { consulta: 'texto' } },
      carpeta: { operacion: 'explorar' },
      eliminados: { operacion: 'eliminados' },
      propiedades: { operacion: 'propiedades' },
    },
  },
  crear: {
    selector: 'accion',
    defecto: 'archivo',
    destinos: { archivo: { operacion: 'crear' }, carpeta: { operacion: 'crear_carpeta' } },
  },
  organizar: {
    selector: 'accion',
    destinos: {
      mover: { operacion: 'mover' },
      renombrar: { operacion: 'renombrar' },
      borrar: { operacion: 'borrar' },
      papelera: { operacion: 'papelera' },
      restaurar: { operacion: 'restaurar' },
      vaciar_papelera: { operacion: 'vaciar_papelera' },
      propiedades: { operacion: 'asignar_propiedades' },
    },
  },
  guardar: {
    selector: 'en',
    defecto: 'conversacion',
    destinos: {
      conversacion: { operacion: 'conversacion_guardar' },
      continuidad: { operacion: 'continuidad_registrar' },
      resultado: { operacion: 'resultado_registrar' },
      resultado_importar: { operacion: 'resultado_importar' },
    },
  },
  actualizar: {
    selector: 'en',
    defecto: 'conversacion',
    destinos: {
      conversacion: { operacion: 'conversacion_guardar' },
      continuidad: { operacion: 'continuidad_actualizar' },
    },
  },
  acceso: {
    selector: 'accion',
    defecto: 'solicitar',
    destinos: { solicitar: { operacion: 'solicitar_acceso' }, retirar: { operacion: 'retirar_acceso' } },
  },
});

const enumOf = (name) => Object.keys(ROUTES[name].destinos);

export const CORE_DEFINITIONS = Object.freeze([
  {
    name: 'estado',
    title: 'Estado de Mind',
    description: 'Carpetas autorizadas, permisos, índices, solicitudes pendientes y conexiones.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'retomar',
    title: 'Retomar una conversación',
    description: 'Con el ID de Mind de una conversación devuelve en una llamada su memoria vigente, resultados, referencias y los destinos donde crear archivos (no hace falta consultar destinos aparte). Sin id, consulta busca la conversación más pertinente.',
    inputSchema: OPEN({
      id: { type: 'string', description: 'ID de Mind de la conversación.' },
      consulta: { type: 'string', description: 'Texto para encontrarla si no conoces el id.' },
      proyecto: { type: 'string' },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'buscar',
    title: 'Buscar',
    description: `Busca sin recorrer el disco. Pendientes, tareas o ideas: en "marcas" con consulta "pendiente" (o la etiqueta del usuario); devuelve abiertos, agrupados por proyecto, con archivo y línea, sin leer los archivos. Otros: archivos (nombre o ruta), conversaciones, continuidad, carpeta (listar su contenido), eliminados (últimos 30 días) o propiedades de una ruta. ${MORE}`,
    inputSchema: OPEN({
      en: { type: 'string', enum: enumOf('buscar') },
      consulta: { type: 'string' },
      carpetas: { type: 'array', items: { type: 'string' } },
      carpeta: FOLDER,
      ruta: RELATIVE,
      limite: { type: 'integer', minimum: 1 },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'leer',
    title: 'Leer',
    description: 'Lee un archivo de texto o documento de oficina y devuelve su version (necesaria para modificar). Si solo necesitas un apartado, usa seccion con su encabezado (coincidencia parcial, sin tildes) en lugar de leer todo; seccion "?" devuelve el índice. desde_linea y lineas acotan por líneas.',
    inputSchema: OPEN({
      carpeta: FOLDER,
      ruta: RELATIVE,
      seccion: { type: 'string', description: 'Texto del encabezado, o "?" para el índice.' },
      desde_linea: { type: 'integer', minimum: 1 },
      lineas: { type: 'integer', minimum: 1 },
    }, ['ruta']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'crear',
    title: 'Crear',
    description: `Crea un archivo de texto (accion archivo: ruta, contenido) o una carpeta (accion carpeta). Nunca sobrescribe. Pasa proyecto y conversacion para aplicar sus destinos. ${MORE}`,
    inputSchema: OPEN({
      accion: { type: 'string', enum: enumOf('crear') },
      carpeta: FOLDER,
      ruta: RELATIVE,
      contenido: { type: 'string' },
      proyecto: { type: 'string' },
      conversacion: { type: 'string' },
    }, ['ruta']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'modificar',
    title: 'Modificar',
    description: 'Con ediciones aplica reemplazos exactos ({buscar, reemplazar, todas}); con contenido y version sustituye el archivo completo. Si el archivo cambió desde la version indicada, no escribe (VERSION_CONFLICT).',
    inputSchema: OPEN({
      carpeta: FOLDER,
      ruta: RELATIVE,
      version: { type: 'string', description: 'Versión leída: "sha256:<64 hex>".' },
      ediciones: {
        type: 'array',
        items: { type: 'object', properties: { buscar: { type: 'string' }, reemplazar: { type: 'string' }, todas: { type: 'boolean' } }, required: ['buscar', 'reemplazar'] },
      },
      contenido: { type: 'string' },
    }, ['ruta']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'organizar',
    title: 'Organizar',
    description: `accion: mover, renombrar (nunca reemplazan), borrar (a la papelera; el usuario confirma), papelera (listar), restaurar, vaciar_papelera (para siempre; doble confirmación) o propiedades (asignar/quitar sin tocar el archivo). ${MORE}`,
    inputSchema: OPEN({
      accion: { type: 'string', enum: enumOf('organizar') },
      carpeta: FOLDER,
      ruta: RELATIVE,
    }, ['accion']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'guardar',
    title: 'Guardar algo nuevo',
    description: `Crea o añade sin reemplazar nada. en conversacion: titulo e importante (conversación nueva). en continuidad: contenido y tipo (registro nuevo). en resultado: archivo ya creado en su destino, con conversacion. Para cambiar algo que ya existe, usa actualizar. ${MORE}`,
    inputSchema: OPEN({
      en: { type: 'string', enum: enumOf('guardar') },
      titulo: { type: 'string' },
      importante: { type: 'string' },
      proyecto: { type: 'string' },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'actualizar',
    title: 'Actualizar lo guardado',
    description: `Reemplaza el contenido de una conversación o un registro de continuidad que ya existe, si sigue en la revision leída (si cambió, no escribe). en conversacion: id, revision e importante. en continuidad: id, revision y contenido. ${MORE}`,
    inputSchema: OPEN({
      en: { type: 'string', enum: enumOf('actualizar') },
      id: { type: 'string' },
      revision: { type: 'integer', minimum: 1 },
      importante: { type: 'string' },
    }, ['id', 'revision']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'acceso',
    title: 'Acceso a carpetas',
    description: `accion solicitar: pide al usuario autorizar una carpeta (ruta absoluta, acceso encontrar|leer|completo) o la continuidad; nunca concede nada por sí sola. accion retirar: reduce permisos o excluye rutas. ${MORE}`,
    inputSchema: OPEN({
      accion: { type: 'string', enum: enumOf('acceso') },
      ruta: { type: 'string' },
      acceso: { type: 'string', enum: ['encontrar', 'leer', 'completo'] },
      motivo: { type: 'string' },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'mind',
    title: 'Consultas de Mind',
    description: 'Ejecuta por su nombre cualquier operación de Mind que solo consulta (destinos, preferencias, funciones, índices, papelera, actualización…). operacion "ayuda" lista las disponibles en mind y mind_cambiar; con detalle describe una.',
    inputSchema: OPEN({
      operacion: { type: 'string', description: '"ayuda" o el nombre de una operación de consulta.' },
      detalle: { type: 'string', description: 'Con ayuda: operación a describir.' },
      argumentos: { type: 'object', description: 'Parámetros de la operación.' },
    }, ['operacion']),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'mind_cambiar',
    title: 'Cambios en Mind',
    description: 'Ejecuta por su nombre una operación de Mind que cambia algo (configurar destinos o preferencias, funciones, índices, respaldo, traslados, aplicar actualizaciones…). Las que borran o activan algo siguen pidiendo confirmación al usuario. mind {operacion:"ayuda"} las lista.',
    inputSchema: OPEN({
      operacion: { type: 'string', description: 'Nombre de la operación.' },
      argumentos: { type: 'object', description: 'Parámetros de la operación.' },
    }, ['operacion']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
]);

const invalid = (message) => new MotorError('INVALID_ARGUMENTS', message);
// Una operación interna solo consulta si lo declara así su propia definición de r3.
const readOnly = (definition) => definition?.annotations?.readOnlyHint === true;
const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

function route(name, args) {
  const spec = ROUTES[name];
  const { [spec.selector]: chosen = spec.defecto, ...rest } = plain(args);
  const target = spec.destinos[chosen];
  if (!target) throw invalid(`${spec.selector} debe ser uno de: ${Object.keys(spec.destinos).join(', ')}.`);
  const mapped = {};
  for (const [key, value] of Object.entries(rest)) mapped[target.renombrar?.[key] ?? key] = value;
  return { operacion: target.operacion, argumentos: mapped };
}

/** Normaliza un encabezado para compararlo: sin marcas, tildes ni mayúsculas. */
function headingKey(value) {
  return String(value).replace(/^#+\s*/u, '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[*_`]/gu, '').trim().toLowerCase();
}

/** Índice de encabezados Markdown, ignorando los que están dentro de bloques de código. */
export function markdownHeadings(content) {
  const lines = String(content).split(/\r?\n/u);
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const fenceMatch = /^\s*(```|~~~)/u.exec(line);
    if (fenceMatch) { fence = fence === fenceMatch[1] ? null : (fence ?? fenceMatch[1]); return; }
    if (fence) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) headings.push({ nivel: match[1].length, titulo: match[2], linea: index + 1 });
  });
  return { lines, headings };
}

/** Devuelve el apartado cuyo encabezado coincide (exacto primero, luego contiene), hasta el siguiente de igual o mayor nivel. */
export function extractSection(content, wanted) {
  const { lines, headings } = markdownHeadings(content);
  const key = headingKey(wanted);
  const found = headings.find((h) => headingKey(h.titulo) === key) ?? headings.find((h) => headingKey(h.titulo).includes(key));
  if (!found) return { encontrado: false, headings };
  const next = headings.find((h) => h.linea > found.linea && h.nivel <= found.nivel);
  const end = next ? next.linea - 1 : lines.length;
  return {
    encontrado: true,
    headings,
    seccion: { titulo: found.titulo, nivel: found.nivel, desde_linea: found.linea, hasta_linea: end },
    contenido: lines.slice(found.linea - 1, end).join('\n'),
  };
}

const index = (headings) => headings.map((h) => `${'  '.repeat(h.nivel - 1)}${h.titulo} (l. ${h.linea})`).join('\n');

/**
 * Envuelve un conjunto de herramientas internas ({definitions, call}) con el
 * catálogo elegido. `call` interno recibe siempre nombres de operaciones de r3.
 */
export function withCatalog(inner, mode = 'nucleo') {
  if (mode === 'completo') return inner;
  const internal = new Map(inner.definitions.map((definition) => [definition.name, definition]));
  const run = (operacion, argumentos, context) => {
    if (!internal.has(operacion)) throw new MotorError('UNKNOWN_TOOL', `Operación desconocida: ${String(operacion).slice(0, 60)}. Usa mind {operacion:"ayuda"}.`);
    return inner.call(operacion, argumentos, context);
  };

  const handlers = {
    estado: (args, context) => run('estado', args, context),

    async retomar(args, context) {
      const { id, consulta, proyecto, ...rest } = plain(args);
      if (Object.keys(rest).length > 0) throw invalid(`Parámetros desconocidos: ${Object.keys(rest).join(', ')}.`);
      let conversationId = id;
      let candidatos;
      if (!conversationId) {
        if (!consulta) throw invalid('Indica id o consulta.');
        const found = await run('conversaciones_buscar', { consulta, limite: 3, ...(proyecto ? { proyecto } : {}) }, context);
        candidatos = found?.conversaciones ?? [];
        conversationId = candidatos[0]?.id;
        if (!conversationId) return { encontrada: false, consulta, candidatos };
      }
      const memoria = await run('conversacion_leer', { id: conversationId }, context);
      const project = proyecto ?? memoria?.conversacion?.proyecto ?? undefined;
      const destinos = await run('destinos_consultar', { conversacion: conversationId, ...(project ? { proyecto: project } : {}) }, context);
      const { aviso_actualizacion: aviso, ...destinosVigentes } = plain(destinos);
      return {
        ...plain(memoria),
        destinos: destinosVigentes,
        ...(candidatos ? { candidatos: candidatos.slice(1) } : {}),
        ...(aviso ? { aviso_actualizacion: aviso } : {}),
      };
    },

    buscar: (args, context) => { const r = route('buscar', args); return run(r.operacion, r.argumentos, context); },
    crear: (args, context) => { const r = route('crear', args); return run(r.operacion, r.argumentos, context); },
    organizar: (args, context) => { const r = route('organizar', args); return run(r.operacion, r.argumentos, context); },
    guardar: (args, context) => {
      if (plain(args).id !== undefined || plain(args).revision !== undefined) {
        throw new MotorError('USE_ACTUALIZAR', 'Para cambiar algo que ya existe usa actualizar con su id y revision.');
      }
      const r = route('guardar', args);
      return run(r.operacion, r.argumentos, context);
    },
    actualizar: (args, context) => {
      const input = plain(args);
      if (input.id === undefined || input.revision === undefined) throw invalid('actualizar necesita id y revision leída.');
      const r = route('actualizar', input);
      return run(r.operacion, r.argumentos, context);
    },
    acceso: (args, context) => { const r = route('acceso', args); return run(r.operacion, r.argumentos, context); },

    modificar(args, context) {
      const input = plain(args);
      if (input.ediciones !== undefined) {
        if (input.contenido !== undefined) throw invalid('Usa ediciones o contenido, no ambos.');
        return run('editar', input, context);
      }
      return run('modificar', input, context);
    },

    async leer(args, context) {
      const { seccion, ...input } = plain(args);
      if (seccion === undefined) return run('leer', input, context);
      if (input.desde_linea !== undefined || input.lineas !== undefined) throw invalid('Usa seccion o desde_linea/lineas, no ambos.');
      const full = await run('leer', input, context);
      const content = typeof full?.contenido === 'string' ? full.contenido : null;
      if (content === null) return full;
      const { contenido: _omit, __mcpText: _text, ...meta } = full;
      // El texto conserva la versión y la ruta: algunos clientes solo muestran el texto.
      const head = JSON.stringify(meta);
      if (String(seccion).trim() === '?') {
        const { headings } = markdownHeadings(content);
        return { ...meta, indice: headings, __mcpText: `${head}\n--- índice ---\n${index(headings) || '(sin encabezados)'}` };
      }
      const part = extractSection(content, seccion);
      if (!part.encontrado) {
        return { ...meta, encontrado: false, seccion_pedida: seccion, indice: part.headings,
          __mcpText: `${head}\n--- no hay un encabezado «${seccion}»; índice ---\n${index(part.headings)}` };
      }
      return { ...meta, seccion: part.seccion, contenido: part.contenido,
        __mcpText: `${JSON.stringify({ ...meta, seccion: part.seccion })}\n--- seccion ---\n${part.contenido}` };
    },

    mind(args, context) {
      const { operacion, detalle, argumentos = {}, ...rest } = plain(args);
      if (Object.keys(rest).length > 0) throw invalid(`Parámetros desconocidos: ${Object.keys(rest).join(', ')}. Pasa los de la operación en argumentos.`);
      if (operacion === 'ayuda') {
        if (detalle) {
          const definition = internal.get(detalle);
          if (!definition) throw new MotorError('UNKNOWN_TOOL', `Operación desconocida: ${String(detalle).slice(0, 60)}.`);
          return { operacion: definition.name, herramienta: readOnly(definition) ? 'mind' : 'mind_cambiar',
            descripcion: definition.description, parametros: definition.inputSchema, anotaciones: definition.annotations ?? null };
        }
        const all = [...internal.values()];
        const list = (defs) => defs.map((d) => ({ nombre: d.name, titulo: d.title ?? d.name }));
        return {
          mind: list(all.filter(readOnly)),
          mind_cambiar: list(all.filter((d) => !readOnly(d))),
          nota: 'mind {operacion:"ayuda", detalle:"<nombre>"} describe sus parámetros.',
        };
      }
      const definition = internal.get(operacion);
      if (definition && !readOnly(definition)) {
        throw new MotorError('USE_MIND_CAMBIAR', `${operacion} cambia datos: usa mind_cambiar.`);
      }
      return run(operacion, plain(argumentos), context);
    },

    mind_cambiar(args, context) {
      const { operacion, argumentos = {}, ...rest } = plain(args);
      if (Object.keys(rest).length > 0) throw invalid(`Parámetros desconocidos: ${Object.keys(rest).join(', ')}. Pasa los de la operación en argumentos.`);
      const definition = internal.get(operacion);
      if (definition && readOnly(definition)) {
        throw new MotorError('USE_MIND', `${operacion} solo consulta: usa mind.`);
      }
      return run(operacion, plain(argumentos), context);
    },
  };

  return Object.freeze({
    ...inner,
    definitions: CORE_DEFINITIONS,
    async call(name, args, context) {
      const handler = handlers[name];
      if (!handler) throw new MotorError('UNKNOWN_TOOL', 'Herramienta desconocida.');
      return handler(args ?? {}, context);
    },
  });
}

/** Instrucciones del servidor para el modo de catálogo. */
export function instructionsFor(mode, fullInstructions) {
  return mode === 'completo' ? fullInstructions : CORE_INSTRUCTIONS;
}

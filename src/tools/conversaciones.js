import { prepareConversationFile } from '../conversation-file.js';
import { RETENTION_MODES } from '../conversation-preferences.js';
import { MotorError } from '../errors.js';
import { only, schema, text, integer, referencesIn } from './helpers.js';

function output(value) {
  return { id: value.id, revision: value.revision, creado: value.createdAt,
    actualizado: value.updatedAt, titulo: value.title, importante: value.important,
    proyecto: value.project, agente: value.agent, id_externo: value.externalId,
    archivo: value.file ?? null,
    preferencias: value.preferences ? preferenceOut(value.preferences) : null,
    referencias: value.references.map(ref => ({
      ...(ref.entry ? { registro: ref.entry } : { ubicacion: ref.locator }),
      ...(ref.relation ? { relacion: ref.relation } : {}),
    })) };
}
const preferenceSchema = schema({ modo: { type: 'string', enum: RETENTION_MODES }, reglas: { type: 'string' }, carpeta_destino: {type:'string',description:'Carpeta absoluta preferida para archivos .md nuevos, dentro de una ubicación autorizada.'} }, ['modo']);
const preferenceIn = value => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MotorError('INVALID_ARGUMENTS', 'Preferencias no válidas.');
  only(value, ['modo','reglas','carpeta_destino']);
  return { mode: value.modo, rules: value.reglas ?? '', ...(value.carpeta_destino === undefined ? {} : {directory:value.carpeta_destino}) };
};
const preferenceOut = value => ({ modo: value.mode, reglas: value.rules, ...(value.directory === undefined ? {} : {carpeta_destino:value.directory}) });
const preferenceResult = value => ({ revision: value.revision, revision_conversacion: value.conversationRevision,
  general: preferenceOut(value.global), excepcion: value.override ? preferenceOut(value.override) : null,
  heredada: value.inherited, efectiva: { ...preferenceOut(value.effective), automatica: value.effective.automatic,
    indicaciones: value.effective.guidance, contenido_max_bytes: value.effective.maxContentBytes } });
const fields = {
  destino: {type:'string',description:'Archivo .md absoluto elegido por el usuario. Omitir conserva el anterior o usa el destino predeterminado de Mind.'},
  solicitado: { type: 'boolean', description: 'true solo si el usuario pidió este guardado expresamente. Obligatorio en modo manual. No acredita identidad.' },
  preferencias: preferenceSchema,
  id: { type: 'string', description: 'ID estable de Mind. Omitir para crear; conservarlo al retomar.' },
  revision: { type: 'integer', minimum: 1, description: 'Revisión leída, obligatoria al actualizar.' },
  titulo: { type: 'string', description: 'Título de la conversación, hasta 200 bytes.' },
  importante: { type: 'string', description: 'Información importante elegida para conservar: hechos, decisiones, pendientes u otro texto. Hasta 64 KiB UTF-8.' },
  proyecto: { type: ['string', 'null'] }, agente: { type: ['string', 'null'] },
  id_externo: { type: ['string', 'null'], description: 'ID nativo si se conoce; es declarado y no concede permisos.' },
  referencias: { type: 'array', items: schema({
    registro: { type: 'string' }, ubicacion: { type: 'string' }, relacion: { type: 'string' },
  }), description: 'Recursos relacionados, en cualquier ubicación. Referencias opacas; no se abren ni conceden acceso.' },
};
export function createConversationTools({ session }) {
  const motor = session.motor;
  return [
    {
      definition: { name: 'conversaciones_preparar', title: 'Preparar búsqueda de conversaciones',
        description: 'Espera la preparación local del índice semántico de conversaciones. Puede tardar en Bases grandes; la búsqueda normal continúa sin esperar. Útil desde CLI, que no mantiene un proceso entre llamadas. No descarga componentes ni copia historiales. Requiere continuidad leer.',
        inputSchema: schema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
      async handler(args, { requireContinuity }) {
        only(args, []); await requireContinuity('leer');
        const result = await motor.prepareConversationSearch();
        await requireContinuity('leer');
        return { estado: result.error ? 'no_preparada' : 'preparada', incidencia: result.error };
      },
    },
    {
      definition: { name: 'conversacion_preferencias', title: 'Consultar preferencias de conversación',
        description: 'Consulta cómo y cuándo conservar conversaciones: esencial predeterminado, detallado, manual o personalizado. Sin id: general; con id: efectiva y excepción. Leer antes de guardar. Requiere continuidad leer.',
        inputSchema: schema({ id: { type: 'string' } }), annotations: { readOnlyHint: true, openWorldHint: false } },
      async handler(args, { requireContinuity }) {
        only(args, ['id']); await requireContinuity('leer');
        const result = await motor.getConversationPreferences(args.id);
        await requireContinuity('leer'); return preferenceResult(result);
      },
    },
    {
      definition: { name: 'conversacion_configurar', title: 'Personalizar conservación de conversaciones',
        description: 'Cambia preferencias solo por indicación del usuario. Sin id configura la general con su revision; con id configura una excepción usando revision_conversacion. preferencias:null con id restaura herencia. No borra ni modifica el resumen guardado. Requiere continuidad leer y registrar.',
        inputSchema: schema({ id: { type: 'string' }, revision: { type: 'integer', minimum: 0 },
          preferencias: { anyOf: [preferenceSchema, { type: 'null' }] } }, ['revision','preferencias']),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      async handler(args, { requireContinuity }) {
        only(args, ['id','revision','preferencias']); await requireContinuity('leer','registrar');
        const result = await motor.configureConversationPreferences({ id: args.id,
          expectedRevision: args.revision, preferences: preferenceIn(args.preferencias) });
        await requireContinuity('leer'); return preferenceResult(result);
      },
    },
    {
      definition: { name: 'conversacion_guardar', title: 'Guardar conversación en Mind',
        description: 'Antes de guardar consulta conversacion_preferencias. Registra una conversación como elemento o actualiza su información importante. Nueva: titulo e importante. Actualizar: id y revision leída. No exige carpeta ni copia el historial. Requiere continuidad leer y registrar.',
        inputSchema: schema(fields),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      async handler(args, context) {
        const {requireContinuity,source} = context;
        only(args, Object.keys(fields));
        await requireContinuity('leer', 'registrar');
        const input = { source };
        for (const [a, b] of [['id','id'],['revision','expectedRevision'],['titulo','title'],
          ['importante','important'],['proyecto','project'],['agente','agent'],['id_externo','externalId']]) {
          if (Object.hasOwn(args,a)) input[b] = args[a];
        }
        if (Object.hasOwn(args, 'solicitado')) input.explicit = args.solicitado;
        if (Object.hasOwn(args, 'preferencias')) input.preferences = preferenceIn(args.preferencias);
        if (Object.hasOwn(args, 'referencias')) {
          if (!Array.isArray(args.referencias) || args.referencias.some(ref => !ref || typeof ref !== 'object'
              || (Object.hasOwn(ref, 'registro') === Object.hasOwn(ref, 'ubicacion')))) {
            throw new MotorError('INVALID_ARGUMENTS', 'Cada referencia indica registro o ubicacion, no ambos.');
          }
          input.references = referencesIn(args.referencias);
        }
        const before = args.id === undefined ? null : await motor.getConversation(args.id);
        const policy = await motor.getConversationPreferences(args.id);
        if ((policy.effective.mode === 'manual' || args.preferencias?.modo === 'manual') && args.solicitado !== true) throw new MotorError('CONVERSATION_MANUAL_ONLY','El usuario eligió guardar solo cuando lo indique.');
        const file = await prepareConversationFile({motor,before,destination:args.destino,
          directory:args.preferencias?.carpeta_destino ?? policy.effective.directory,context});
        input.file = file.target;
        const value = await motor.saveConversation(input);
        try { await file.write(value); }
        catch(error) { return {estado:'pendiente_archivo',conversacion:output(value),archivo:{estado:'pendiente',ruta:file.target,codigo:error.code ?? 'WRITE_FAILED'},nota:'El elemento quedó en continuidad, pero el archivo no pudo actualizarse. No afirmar guardado completo.'}; }
        return { estado: args.id === undefined ? 'registrada' : 'actualizada', conversacion: output(value) };
      },
    },
    {
      definition: { name: 'conversaciones_buscar', title: 'Buscar conversaciones',
        description: 'Busca por palabras y significado con modelo local; predeterminado hibrida. En primera indexación devuelve preparando y continúa en segundo plano; las coincidencias semánticas pueden ser parciales. Si falta el componente o falla, devuelve búsqueda por palabras y estado semantica. No carga historiales. Devuelve extractos breves e IDs para leer. Consulta vacía: recientes. Requiere continuidad leer.',
        inputSchema: schema({ modo: { type: 'string', enum: ['hibrida','palabras'] }, consulta: { type: 'string' }, proyecto: { type: 'string' },
          limite: { type: 'integer', minimum: 1, maximum: 50 } }),
        annotations: { readOnlyHint: true, openWorldHint: false } },
      async handler(args, { requireContinuity }) {
        only(args, ['consulta','proyecto','limite','modo']);
        await requireContinuity('leer');
        const found = await motor.searchConversations({
          mode: args.modo,
          query: text(args.consulta, 'consulta', { optional: true, allowEmpty: true, max: 256 }),
          project: text(args.proyecto, 'proyecto', { optional: true, max: 200 }),
          limit: integer(args.limite, 'limite', { min: 1, max: 50 }),
        });
        await requireContinuity('leer');
        return { semantica: { estado: found.semantic.status, fragmentos_generados: found.semantic.embedded, modelo: found.semantic.model, conversaciones_pendientes: found.semantic.pending ?? 0 },
          total: found.total, mostradas: found.results.length,
          conversaciones: found.results.map(row => ({ id: row.id, revision: row.revision,
            titulo: row.title, proyecto: row.project, actualizado: row.updatedAt, extracto: row.excerpt, coincidencia: row.match })),
          indice: { examinados: found.index.examined, contenidos_leidos: found.index.read,
            omitidos: found.index.omitted, incompleto: found.index.omitted > 0 } };
      },
    },
    {
      definition: { name: 'conversacion_leer', title: 'Leer lo importante de una conversación',
        description: 'Recupera por ID la información importante vigente y sus referencias. No abre recursos relacionados ni carga el historial de la aplicación. Requiere continuidad leer.',
        inputSchema: schema({ id: { type: 'string' } }, ['id']),
        annotations: { readOnlyHint: true, openWorldHint: false } },
      async handler(args, { requireContinuity }) {
        only(args, ['id']);
        await requireContinuity('leer');
        const value = await motor.getConversation(text(args.id, 'id', { max: 64 }));
        await requireContinuity('leer');
        return { conversacion: output(value) };
      },
    },
  ];
}

import { MotorError } from '../errors.js';
import { only, schema, text, integer, referencesIn } from './helpers.js';

function output(value) {
  return { id: value.id, revision: value.revision, creado: value.createdAt,
    actualizado: value.updatedAt, titulo: value.title, importante: value.important,
    proyecto: value.project, agente: value.agent, id_externo: value.externalId,
    referencias: value.references.map(ref => ({
      ...(ref.entry ? { registro: ref.entry } : { ubicacion: ref.locator }),
      ...(ref.relation ? { relacion: ref.relation } : {}),
    })) };
}
const fields = {
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
      definition: { name: 'conversacion_guardar', title: 'Guardar conversación en Mind',
        description: 'Registra una conversación como elemento o actualiza su información importante. Nueva: titulo e importante. Actualizar: id y revision leída. No exige carpeta ni copia el historial. Requiere continuidad leer y registrar.',
        inputSchema: schema(fields),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      async handler(args, { requireContinuity, source }) {
        only(args, Object.keys(fields));
        await requireContinuity('leer', 'registrar');
        const input = { source };
        for (const [a, b] of [['id','id'],['revision','expectedRevision'],['titulo','title'],
          ['importante','important'],['proyecto','project'],['agente','agent'],['id_externo','externalId']]) {
          if (Object.hasOwn(args,a)) input[b] = args[a];
        }
        if (Object.hasOwn(args, 'referencias')) {
          if (!Array.isArray(args.referencias) || args.referencias.some(ref => !ref || typeof ref !== 'object'
              || (Object.hasOwn(ref, 'registro') === Object.hasOwn(ref, 'ubicacion')))) {
            throw new MotorError('INVALID_ARGUMENTS', 'Cada referencia indica registro o ubicacion, no ambos.');
          }
          input.references = referencesIn(args.referencias);
        }
        const value = await motor.saveConversation(input);
        return { estado: args.id === undefined ? 'registrada' : 'actualizada', conversacion: output(value) };
      },
    },
    {
      definition: { name: 'conversaciones_buscar', title: 'Buscar conversaciones',
        description: 'Busca por palabras en títulos e información importante indexada, sin cargar todos los historiales. Devuelve extractos breves e IDs para leer. Consulta vacía: recientes. Requiere continuidad leer.',
        inputSchema: schema({ consulta: { type: 'string' }, proyecto: { type: 'string' },
          limite: { type: 'integer', minimum: 1, maximum: 50 } }),
        annotations: { readOnlyHint: true, openWorldHint: false } },
      async handler(args, { requireContinuity }) {
        only(args, ['consulta','proyecto','limite']);
        await requireContinuity('leer');
        const found = await motor.searchConversations({
          query: text(args.consulta, 'consulta', { optional: true, allowEmpty: true, max: 256 }),
          project: text(args.proyecto, 'proyecto', { optional: true, max: 200 }),
          limit: integer(args.limite, 'limite', { min: 1, max: 50 }),
        });
        await requireContinuity('leer');
        return { total: found.total, mostradas: found.results.length,
          conversaciones: found.results.map(row => ({ id: row.id, revision: row.revision,
            titulo: row.title, proyecto: row.project, actualizado: row.updatedAt, extracto: row.excerpt })),
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

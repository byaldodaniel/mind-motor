import { MotorError } from '../errors.js';
import { only, text, schema } from './helpers.js';
import { functionServiceFor } from '../automations/service.js';
import { schedulerFor } from '../automations/scheduler.js';

/**
 * Función 04 — funciones y automatizaciones, para el agente. Una función es una
 * definición de datos que nombra un ejecutor del catálogo fijo de Mind (nunca
 * código) y sus parámetros. Crearla no concede nada: al ejecutarse, el ejecutor
 * comprueba los permisos que el usuario dio en cada carpeta. Activarla por
 * horario o por evento requiere la autorización explícita del usuario para esa
 * versión exacta; cualquier cambio de la definición la caduca. Desactivar nunca
 * requiere confirmación.
 */

const ID = { type: 'string', description: 'Identificador de la función: minúsculas, números, - y _ (hasta 64).' };
const DEFINITION = {
  type: 'object',
  description: 'JSON: { "nombre": "...", "ejecutor": "<del catálogo de \\"funciones\\">", "parametros": {...}, "activacion": { "tipo": "manual" } | { "tipo": "horario", "frecuencia": "intervalo", "minutos": 60 } | { "tipo": "horario", "frecuencia": "diaria", "hora": "08:30" } | { "tipo": "horario", "frecuencia": "semanal", "dias": ["lunes"], "hora": "09:00" } | { "tipo": "evento", "carpeta": "<id>", "espera_segundos": 60 } }.',
};

const DEFINITIONS = [
  {
    name: 'funciones',
    title: 'Funciones de Mind',
    description: 'Lista los ejecutores disponibles (catálogo fijo de Mind) y las funciones definidas, con su activación, autorización, próximo turno y si el programador del sistema está instalado.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'crear_funcion',
    title: 'Crear función',
    description: 'Define una función reutilizable sobre un ejecutor del catálogo. No concede permisos ni la activa: ejecútala con "ejecutar_funcion" o pide su activación automática con "activar_funcion".',
    inputSchema: schema({ id: ID, definicion: DEFINITION }, ['id', 'definicion']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'modificar_funcion',
    title: 'Modificar función',
    description: 'Sustituye la definición. Si estaba activada, su autorización caduca y el usuario debe volver a autorizarla.',
    inputSchema: schema({ id: ID, definicion: DEFINITION }, ['id', 'definicion']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'retirar_funcion',
    title: 'Retirar función',
    description: 'Retira la definición con su autorización e historial. No borra lo que la función escribió.',
    inputSchema: schema({ id: ID }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ejecutar_funcion',
    title: 'Ejecutar función',
    description: 'Ejecuta ahora una función, con los permisos que el usuario concedió en cada carpeta. Devuelve un resumen sin contenido.',
    inputSchema: schema({ id: ID }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'activar_funcion',
    title: 'Activar función automática',
    description: 'Pide al usuario que autorice que una función con activación por horario o por evento se ejecute sola. Si tu cliente no puede mostrarlo, queda pendiente para "mind autorizar".',
    inputSchema: schema({ id: ID, motivo: { type: 'string' } }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'desactivar_funcion',
    title: 'Desactivar función automática',
    description: 'Detiene las ejecuciones automáticas de una función. No requiere confirmación.',
    inputSchema: schema({ id: ID }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'historial_funcion',
    title: 'Historial de ejecuciones',
    description: 'Últimas ejecuciones (manuales o automáticas) con su resultado, sin contenido.',
    inputSchema: schema({ id: ID }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const functionId = (value) => text(value, 'id', { max: 64 });

/** Estado de una función para el agente, sin la definición interna. */
function summary(state) {
  return {
    ejecutor: state.executor ?? null, activacion: state.activation ?? null, automatica: state.estado,
    ...(state.motivo ? { motivo: state.motivo } : {}),
    autorizada_por: state.consent?.enabled ? state.consent.channel : null,
    proximo_turno: Number.isFinite(state.next) ? new Date(state.next).toISOString() : null,
    ...(state.problem ? { problema: state.problem.message ?? String(state.problem) } : {}),
  };
}

function definitionIn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MotorError('INVALID_ARGUMENTS', 'definicion debe ser un objeto JSON.');
  return value;
}

export function createFunctionTools({ session, connection }) {
  const service = () => functionServiceFor(session);
  const handlers = {
    async funciones(args) {
      only(args, []);
      const { readInstallation } = await import('../automations/system.js');
      const installation = await readInstallation(session.motor.baseDirectory).catch(() => null);
      return {
        ejecutores: service().executors(),
        funciones: await service().overview(),
        en_sesion: schedulerFor(session) ? 'activo' : 'inactivo (sin observación)',
        programador_del_sistema: installation?.state === 'instalado'
          ? `instalado (${installation.record.kind}): las funciones autorizadas se ejecutan también con Mind cerrado`
          : 'no instalado: fuera de las sesiones no se ejecuta nada. El usuario lo instala con "mind programador instalar".',
      };
    },

    async crear_funcion(args, { source }) {
      only(args, ['id', 'definicion']);
      const id = functionId(args.id);
      const created = await service().create(id, definitionIn(args.definicion));
      await session.audit('funcion-creada', { funcion: id, ejecutor: args.definicion.ejecutor, cliente: source });
      return { ...summary(await service().status(id)), estado: 'creada', id };
    },

    async modificar_funcion(args, { source }) {
      only(args, ['id', 'definicion']);
      const id = functionId(args.id);
      const updated = await service().update(id, definitionIn(args.definicion));
      await session.audit('funcion-modificada', { funcion: id, cliente: source });
      return {
        estado: 'modificada', id, autorizacion_caducada: updated.authorizationExpired,
        ...(updated.authorizationExpired ? { nota: 'La autorización automática anterior ya no vale: pide de nuevo "activar_funcion".' } : {}),
      };
    },

    async retirar_funcion(args, { source }) {
      only(args, ['id']);
      const id = functionId(args.id);
      await service().retire(id);
      await session.audit('funcion-retirada', { funcion: id, cliente: source });
      return { estado: 'retirada', id };
    },

    async ejecutar_funcion(args, { source }) {
      only(args, ['id']);
      const id = functionId(args.id);
      const outcome = await service().execute(id, { origin: 'manual', client: source });
      await session.audit('funcion-ejecutada', { funcion: id, estado: outcome.estado, codigo: outcome.codigo ?? null, cliente: source });
      return { id, ...outcome };
    },

    async activar_funcion(args, { consent, source }) {
      only(args, ['id', 'motivo']);
      const id = functionId(args.id);
      const reason = text(args.motivo, 'motivo', { optional: true, max: 300 });
      const prepared = await service().prepareActivation(id);
      if (prepared.missing.length > 0) {
        const { describeMissing } = await import('../automations/service.js');
        throw new MotorError('ACCESS_NOT_GRANTED', `Antes de activarla faltan permisos del usuario: ${describeMissing(prepared.missing)}. Pídelos con "solicitar_acceso".`);
      }
      const outcome = await consent.askAutomation({
        automation: { functionId: id, generation: prepared.generation, fingerprint: prepared.fingerprint },
        lines: prepared.lines, reason, clientInfo: connection?.clientInfo,
      });
      if (outcome.status === 'pending') {
        return {
          estado: 'pendiente', solicitud: outcome.request.id,
          que_hacer: 'El usuario debe aprobar la activación con "mind autorizar" en la carpeta de Mind. Hasta entonces no se ejecuta sola.',
        };
      }
      if (outcome.status !== 'approved') return { estado: 'rechazado', nota: 'El usuario no autorizó la activación automática.' };
      await service().authorize(id, { generation: prepared.generation, fingerprint: prepared.fingerprint, channel: outcome.channel, client: source });
      await session.audit('funcion-activada', { funcion: id, canal: outcome.channel, cliente: source });
      return { ...summary(await service().status(id)), estado: 'activada', id };
    },

    async desactivar_funcion(args, { source }) {
      only(args, ['id']);
      const id = functionId(args.id);
      await service().deactivate(id, { channel: 'formulario-del-cliente', client: source });
      await session.audit('funcion-desactivada', { funcion: id, cliente: source });
      return { estado: 'desactivada', id };
    },

    async historial_funcion(args) {
      only(args, ['id']);
      const id = args.id === undefined ? null : functionId(args.id);
      return { id, ejecuciones: await service().history(id, 20) };
    },
  };
  return DEFINITIONS.map((definition) => ({ definition, handler: handlers[definition.name] }));
}

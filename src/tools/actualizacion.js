import { only, schema } from './helpers.js';
import { describeUpdate, postponeUpdate, POSTPONE_DAYS } from '../update-assistant.js';
import { MotorError } from '../errors.js';
import { applyUpdateConsent } from '../update-consent.js';

/**
 * Actualización asistida: el agente informa y el usuario decide. Consultar no
 * descarga ni instala; posponer solo se usa cuando el usuario lo pide.
 */
export function createUpdateTools({ session, requestUpdate }) {
  return [
    {
      definition: {
        name: 'actualizacion_consultar', title: 'Consultar la actualización de Mind',
        description: 'Úsala cuando el usuario pregunte por la nueva versión de Mind: qué cambia, por qué conviene o cómo afecta a su Base, carpetas y conversaciones. Devuelve lo que declara la entrega firmada y lo comprobado en este equipo (formato de la Base, espacio). No descarga ni instala nada.',
        inputSchema: schema({}), annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async handler(args) {
        only(args, []);
        return describeUpdate({ layout: session.layout });
      },
    },
    {
      definition: {
        name: 'actualizacion_posponer', title: 'Recordar la actualización más tarde',
        description: `Solo cuando el usuario pida que se lo recuerden después. Calla el aviso de esta entrega en todas sus conversaciones durante ${POSTPONE_DAYS.join(', ')} días (1 por defecto; las de seguridad, 1 como máximo). No instala nada.`,
        inputSchema: schema({ dias: { type: 'integer', enum: [...POSTPONE_DAYS] } }), annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async handler(args) {
        only(args, ['dias']);
        if (args.dias !== undefined && !POSTPONE_DAYS.includes(args.dias)) throw new MotorError('INVALID_ARGUMENTS', `dias debe ser ${POSTPONE_DAYS.join(', ')}.`);
        return postponeUpdate({ layout: session.layout, dias: args.dias ?? 1 });
      },
    },
    {
      definition: {
        name: 'actualizacion_aplicar', title: 'Aplicar la actualización de Mind',
        description: 'Solo cuando el usuario pida expresamente aplicar la nueva versión. Solicita su confirmación en el formulario del cliente; si no admite formularios, devuelve un código de un solo uso para una segunda llamada tras la confirmación expresa del usuario. La autorización corresponde a la entrega firmada exacta y caduca si cambia. Mind prepara en segundo plano, espera que no haya trabajo ni formularios pendientes y conserva los datos. No uses esta herramienta para consultar o descargar por anticipado.',
        inputSchema: schema({ codigo: { type: 'string', minLength: 24, maxLength: 24, description: 'Código que devolvió el primer paso. Envíalo únicamente después de que el usuario haya confirmado aplicar esta entrega.' } }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async handler(args, context = {}) {
        only(args, ['codigo']);
        return applyUpdateConsent({ layout: session.layout, consent: context.consent, codigo: args.codigo, requestUpdate });
      },
    },
  ];
}

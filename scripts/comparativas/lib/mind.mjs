import { openSession } from '../../../src/session.js';
import { resolveLayout } from '../../../src/layout.js';
import { MOTOR_VERSION } from '../../../src/version.js';
import { normalizeAccess, describeAccess, CONTINUITY_LEVELS } from '../../../src/access-policy.js';

export { MOTOR_VERSION };

/**
 * El desarrollador actúa como usuario: abre una sesión administrativa del
 * Motor (sin observación), registra las carpetas y guarda la decisión de
 * acceso por el canal "consola", como haría `mind autorizar`. No hay
 * formulario ni agente de por medio; queda anotado en la auditoría de la Base.
 * @param {{ base: string, carpetas?: string[], acceso?: string[], continuidad?: string[] | null }} opciones
 * @returns {Promise<{ id: string, path: string }[]>}
 */
export async function autorizarComoUsuario({ base, carpetas = [], acceso = ['encontrar', 'leer'], continuidad = null }) {
  const layout = await resolveLayout({ base, env: { MIND_PYTHON: process.env.MIND_PYTHON } });
  const sesion = await openSession({ layout, motorVersion: MOTOR_VERSION, observe: false });
  try {
    const autorizadas = [];
    for (const carpeta of carpetas) {
      const registrada = await sesion.motor.authorizeFolder(carpeta);
      const decision = await sesion.policy.set(registrada.id, normalizeAccess(acceso), { channel: 'consola' });
      await sesion.audit('carpeta-autorizada', {
        carpeta: registrada.id, ruta: registrada.path, permisos: describeAccess(decision.access), canal: 'consola',
        nota: 'comparativas: el desarrollador actúa como usuario',
      });
      autorizadas.push(registrada);
    }
    if (continuidad) {
      const guardada = await sesion.policy.setContinuity(continuidad, { channel: 'consola' });
      await sesion.audit('continuidad-autorizada', {
        permisos: describeAccess(guardada, CONTINUITY_LEVELS), canal: 'consola', nota: 'comparativas: el desarrollador actúa como usuario',
      });
    }
    return autorizadas;
  } finally {
    await sesion.close();
  }
}

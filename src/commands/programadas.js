import { functionServiceFor } from '../automations/service.js';
import { callCentralRpc, checkHealthyConnector, stopCentralMotor } from '../connector.js';
import { baseExists } from './programador.js';

/**
 * mind programadas — lo ejecuta el programador del sistema (o el usuario):
 * corre una vez los turnos vencidos de las funciones automáticas que el
 * usuario autorizó y termina. Sin terminal ni preguntas; si no hay Base, no
 * crea ninguna.
 */
export async function run({ layout, withSession, print }) {
  const installed = await layout();
  if (!(await baseExists(installed.baseDirectory))) {
    print({ ejecutadas: 0, nota: 'No hay Base.' });
    return 0;
  }
  const active = await checkHealthyConnector(installed.baseDirectory);
  const useNative = process.env.MIND_MOTOR_NATIVO === '1' || active?.health?.backend === 'rust';
  let outcomes;
  if (useNative) {
    const res = await callCentralRpc({
      layout: installed,
      baseDirectory: installed.baseDirectory,
      console: true,
      payload: { accion: 'consola', operacion: 'ejecutar_programadas' },
    });
    outcomes = res.resultados ?? [];
    if (!active) {
      await stopCentralMotor({ baseDirectory: installed.baseDirectory, onlyIfIdle: true }).catch(() => {});
    }
  } else {
    outcomes = await withSession(async (session) => functionServiceFor(session).runDue({ origin: 'programada' }));
  }
  print({ ejecutadas: outcomes.length, resultados: outcomes.map((item) => ({ funcion: item.funcion ?? item.id ?? null, estado: item.estado, codigo: item.codigo ?? null })) });
  return outcomes.some((item) => item.estado === 'fallida') ? 1 : 0;
}

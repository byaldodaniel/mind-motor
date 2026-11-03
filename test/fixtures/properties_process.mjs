// Proceso independiente: verifica persistencia real sin compartir cachés del anfitrión.
import { openMotor } from '../../src/motor.js';
import { openSession } from '../../src/session.js';
import { createCustomIndexes } from '../../src/custom-index.js';

const config = JSON.parse(process.argv[2]);
let session;
try {
  if (config.operation === 'properties') {
    const motor = await openMotor({ baseDirectory: config.layout.baseDirectory });
    const released = new Promise((resolve) => process.once('message', resolve));
    process.send({ phase: 'ready' });
    await released;
    await motor.setProperties(config.folderId, 'notas.txt', { set: config.properties });
    process.send({ phase: 'result', properties: await motor.getProperties(config.folderId, 'notas.txt') });
  } else {
    session = await openSession({ layout: config.layout, motorVersion: '0.0.0-prueba', observe: false });
    await session.start();
    const result = await createCustomIndexes({ session }).regenerate(config.id);
    process.send({ phase: 'result', result });
  }
} catch (error) {
  process.send({ phase: 'error', code: error.code, message: error.message });
  process.exitCode = 1;
} finally {
  await session?.close();
  process.disconnect();
}

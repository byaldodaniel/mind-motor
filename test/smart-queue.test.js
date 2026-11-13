import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSmartQueue,
  QUEUE_PRIORITY,
  classifyToolPriority,
  resolveToolResourceKeys,
} from '../src/smart-queue.js';

// Las pruebas comprueban orden y estado, nunca tiempos: deben dar lo mismo en
// Windows, macOS y Linux, en máquinas lentas o rápidas.

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** Deja correr las tareas pendientes de la cola de microtareas y de E/S. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function assertIdle(queue) {
  const status = queue.status();
  assert.equal(status.activeLocks, 0, 'no quedan claves reservadas');
  assert.equal(status.activeWrites, 0);
  assert.equal(status.queuedWrites, 0);
  assert.equal(status.suspendedWrites, 0);
  assert.equal(status.activeReads, 0);
  assert.equal(status.foregroundBusy, false);
}

/** Vigila que nunca corran a la vez dos tramos exclusivos de la misma clave. */
function exclusiveTracker() {
  let inside = 0;
  const violations = [];
  return {
    async section(label, body) {
      inside += 1;
      if (inside > 1) violations.push(label);
      try {
        return await body();
      } finally {
        inside -= 1;
      }
    },
    violations,
  };
}

test('leer se clasifica como lectura P1 y no reserva carpeta', async () => {
  assert.equal(classifyToolPriority('leer', { carpeta: 'a', ruta: 'x.txt' }), QUEUE_PRIORITY.READ);
  assert.equal(classifyToolPriority('buscar', {}), QUEUE_PRIORITY.READ);
  assert.equal(classifyToolPriority('crear', {}), QUEUE_PRIORITY.WRITE);
  assert.equal(classifyToolPriority('modificar', {}), QUEUE_PRIORITY.WRITE);
  assert.equal(classifyToolPriority('borrar', {}), QUEUE_PRIORITY.WRITE);
  assert.equal(classifyToolPriority('destino_resolver', { preparar: true }), QUEUE_PRIORITY.WRITE);
  assert.equal(classifyToolPriority('destino_resolver', {}), QUEUE_PRIORITY.READ);

  // Dos lecturas de la misma carpeta corren a la vez.
  const queue = createSmartQueue();
  const both = gate();
  let running = 0;
  let maxRunning = 0;
  const read = () => queue.runRead(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    if (running === 2) both.open();
    await both.promise;
    running -= 1;
  });
  await Promise.all([read(), read()]);
  assert.equal(maxRunning, 2);
  assertIdle(queue);
});

test('claves de recurso: multiclave, normalización igual en todo sistema', async () => {
  assert.deepEqual(
    await resolveToolResourceKeys('mover', { carpeta: 'A', carpeta_destino: 'B' }, async (ref) => ref),
    ['folder:a', 'folder:b'],
  );
  assert.deepEqual(
    await resolveToolResourceKeys('crear_indice', { carpeta: 'A', carpeta_csv: 'C' }, async (ref) => ref),
    ['folder:a', 'folder:c'],
  );
  // Sin resolutor: la misma carpeta escrita con otras mayúsculas o barra final comparte clave.
  const [upper] = await resolveToolResourceKeys('crear', { carpeta: '/Users/Ana/Docs/' });
  const [lower] = await resolveToolResourceKeys('crear', { carpeta: '/users/ana/docs' });
  assert.equal(upper, lower);
  // NFD (macOS) y NFC son la misma clave.
  const [nfd] = await resolveToolResourceKeys('crear', { carpeta: '/Café' });
  const [nfc] = await resolveToolResourceKeys('crear', { carpeta: '/café' });
  assert.equal(nfd, nfc);
  assert.deepEqual(await resolveToolResourceKeys('crear', { conversacion: 'c1' }), ['dest-conv:c1']);
  assert.deepEqual(await resolveToolResourceKeys('resultado_registrar', {}), ['destinations:default']);
  assert.deepEqual(await resolveToolResourceKeys('crear_respaldo', {}), ['backup']);
  assert.deepEqual(await resolveToolResourceKeys('conversacion_guardar', { id: 'c1' }), ['conversation:c1']);
});

test('suspendWhile: otra escritura de la misma clave avanza durante la suspensión y la primera recupera la exclusión', async () => {
  const queue = createSmartQueue();
  const tracker = exclusiveTracker();
  const order = [];
  const user = gate();
  const secondStarted = gate();
  const secondCanEnd = gate();

  const first = queue.runWrite(['folder:a'], () => tracker.section('first-1', async () => {
    order.push('first-start');
    return 'pre';
  }).then(async () => {
    const answer = await queue.suspendWhile(async () => {
      order.push('first-waiting-user');
      return user.promise;
    });
    return tracker.section('first-2', async () => {
      order.push(`first-resumed:${answer}`);
      return 'first-done';
    });
  }));

  await settle();
  assert.deepEqual(queue.status().suspendedWrites, 1);
  assert.equal(queue.status().activeWrites, 0);
  assert.equal(queue.hasForegroundDemand(), false, 'la espera al usuario no frena el trabajo de fondo');

  const second = queue.runWrite(['folder:a'], () => tracker.section('second', async () => {
    order.push('second-start');
    secondStarted.open();
    await secondCanEnd.promise;
    order.push('second-end');
    return 'second-done';
  }));
  await secondStarted.promise;

  // El usuario responde mientras la segunda aún tiene la clave: la primera espera su turno.
  user.open('si');
  await settle();
  assert.equal(order.includes('first-resumed:si'), false, 'no recupera la clave antes de que la suelte la segunda');
  assert.equal(queue.status().queuedWrites, 1);
  assert.equal(queue.status().activeWrites, 1);

  secondCanEnd.open();
  assert.deepEqual(await Promise.all([first, second]), ['first-done', 'second-done']);
  assert.deepEqual(order, [
    'first-start', 'first-waiting-user', 'second-start', 'second-end', 'first-resumed:si',
  ]);
  assert.deepEqual(tracker.violations, []);
  assertIdle(queue);
});

test('suspendWhile: al reanudar, una escritura que llega después espera al tramo final', async () => {
  const queue = createSmartQueue();
  const tracker = exclusiveTracker();
  const user = gate();
  const finalGate = gate();
  const inFinal = gate();
  const order = [];

  const first = queue.runWrite(['folder:a'], async () => {
    await queue.suspendWhile(() => user.promise);
    await tracker.section('first-final', async () => {
      order.push('first-final-start');
      inFinal.open();
      await finalGate.promise;
      order.push('first-final-end');
    });
  });
  user.open();
  await inFinal.promise;
  const late = queue.runWrite(['folder:a'], () => tracker.section('late', async () => { order.push('late'); }));
  await settle();
  assert.deepEqual(order, ['first-final-start']);
  finalGate.open();
  await Promise.all([first, late]);
  assert.deepEqual(order, ['first-final-start', 'first-final-end', 'late']);
  assert.deepEqual(tracker.violations, []);
  assertIdle(queue);
});

test('suspendWhile propaga el error de fn tras recuperar la exclusión', async () => {
  const queue = createSmartQueue();
  const seen = [];
  await assert.rejects(queue.runWrite(['k'], async () => {
    try {
      await queue.suspendWhile(async () => { throw new Error('rechazado'); });
    } catch (error) {
      seen.push(queue.status().activeWrites, error.message);
      throw error;
    }
  }), /rechazado/);
  assert.deepEqual(seen, [1, 'rechazado']);
  assertIdle(queue);
});

test('suspendWhile fuera de una escritura solo ejecuta fn', async () => {
  const queue = createSmartQueue();
  assert.equal(await queue.suspendWhile(async () => 7), 7);
  assert.equal(await queue.runRead(() => queue.suspendWhile(async () => 8)), 8);
  assertIdle(queue);
});

test('cancelación durante la suspensión: no vuelve a la cola ni deja claves', async () => {
  const queue = createSmartQueue();
  const controller = new AbortController();
  const user = gate();
  const write = queue.runWrite(['folder:a'], async () => {
    await queue.suspendWhile(() => user.promise);
    return 'no-debe-llegar';
  }, { signal: controller.signal });
  await settle();
  assert.equal(queue.status().activeLocks, 0);
  controller.abort(new Error('cancelada'));
  user.open('si');
  await assert.rejects(write, /cancelada/);
  assertIdle(queue);
  // La clave sigue utilizable.
  assert.equal(await queue.runWrite(['folder:a'], async () => 'ok'), 'ok');
  assertIdle(queue);
});

test('cancelación durante la readquisición: sale de la cola sin bloquear a nadie', async () => {
  const queue = createSmartQueue();
  const controller = new AbortController();
  const user = gate();
  const holderStarted = gate();
  const holderEnd = gate();
  const order = [];

  const first = queue.runWrite(['folder:a'], async () => {
    await queue.suspendWhile(() => user.promise);
    order.push('first-final');
  }, { signal: controller.signal });
  await settle();
  const holder = queue.runWrite(['folder:a'], async () => {
    holderStarted.open();
    await holderEnd.promise;
    order.push('holder');
  });
  await holderStarted.promise;
  user.open();
  await settle();
  // Espera en cola detrás de holder, y llega otra detrás de ella.
  assert.equal(queue.status().queuedWrites, 1);
  const after = queue.runWrite(['folder:a'], async () => { order.push('after'); });
  controller.abort(new Error('cancelada'));
  await assert.rejects(first, /cancelada/);
  holderEnd.open();
  await Promise.all([holder, after]);
  assert.deepEqual(order, ['holder', 'after']);
  assertIdle(queue);
});

test('cancelar la última escritura en espera no rompe la exclusión de la que la tiene', async () => {
  // Defecto de la versión anterior: la reserva cancelada borraba la cola de la clave
  // y una escritura posterior entraba a la vez que la que seguía en curso.
  const queue = createSmartQueue();
  const tracker = exclusiveTracker();
  const holderEnd = gate();
  const holderStarted = gate();
  const holder = queue.runWrite(['k'], () => tracker.section('holder', async () => {
    holderStarted.open();
    await holderEnd.promise;
  }));
  await holderStarted.promise;
  const controller = new AbortController();
  const cancelled = queue.runWrite(['k'], async () => {}, { signal: controller.signal });
  await settle();
  controller.abort(new Error('cancelada'));
  await assert.rejects(cancelled, /cancelada/);
  let lateRan = false;
  const late = queue.runWrite(['k'], () => tracker.section('late', async () => { lateRan = true; }));
  await settle();
  assert.equal(lateRan, false, 'la posterior espera a la que tiene la clave');
  holderEnd.open();
  await Promise.all([holder, late]);
  assert.equal(lateRan, true);
  assert.deepEqual(tracker.violations, []);
  assertIdle(queue);
});

test('multiclave: órdenes cruzados y suspensión de un mover no interbloquean', async () => {
  const queue = createSmartQueue();
  const cross = await Promise.all([
    queue.runWrite(['folder:x', 'folder:y'], async () => 'xy'),
    queue.runWrite(['folder:y', 'folder:x'], async () => 'yx'),
    queue.runWrite(['folder:x'], async () => 'x'),
  ]);
  assert.deepEqual(cross, ['xy', 'yx', 'x']);

  // Un mover suspendido suelta ambas claves; otras escrituras sobre cada una avanzan.
  const user = gate();
  const order = [];
  const move = queue.runWrite(['folder:x', 'folder:y'], async () => {
    await queue.suspendWhile(() => user.promise);
    order.push('move');
  });
  await settle();
  await queue.runWrite(['folder:y', 'folder:x'], async () => { order.push('yx'); });
  await queue.runWrite(['folder:x'], async () => { order.push('x'); });
  // Al reanudar, se pone a la cola de las dos claves a la vez, detrás de lo ya encolado.
  const blockerEnd = gate();
  const blockerStarted = gate();
  const blocker = queue.runWrite(['folder:y'], async () => {
    blockerStarted.open();
    await blockerEnd.promise;
    order.push('y');
  });
  await blockerStarted.promise;
  user.open();
  await settle();
  const xOnly = queue.runWrite(['folder:x'], async () => { order.push('x-late'); });
  await settle();
  // x-late llegó después de la reserva del mover sobre x: espera aunque x esté libre.
  assert.deepEqual(order, ['yx', 'x']);
  blockerEnd.open();
  await Promise.all([move, blocker, xOnly]);
  assert.deepEqual(order, ['yx', 'x', 'y', 'move', 'x-late']);
  assertIdle(queue);
});

test('suspensiones anidadas y simultáneas dentro de una misma escritura', async () => {
  const queue = createSmartQueue();
  const tracker = exclusiveTracker();
  const order = [];

  // Anidada: la interior no recupera la clave mientras la exterior sigue esperando.
  const outerUser = gate();
  const nested = queue.runWrite(['k'], async () => {
    await queue.suspendWhile(async () => {
      await queue.suspendWhile(async () => 'inner');
      order.push(`inner-status:${queue.status().activeWrites}`);
      await outerUser.promise;
    });
    await tracker.section('nested-final', async () => { order.push('nested-final'); });
  });
  await settle();
  await queue.runWrite(['k'], () => tracker.section('other', async () => { order.push('other'); }));
  outerUser.open();
  await nested;
  assert.deepEqual(order, ['inner-status:0', 'other', 'nested-final']);
  assertIdle(queue);

  // Simultáneas: la clave se suelta una vez y cada una vuelve con exclusión.
  order.length = 0;
  const a = gate();
  const b = gate();
  const siblings = queue.runWrite(['k'], async () => {
    await Promise.all([
      queue.suspendWhile(() => a.promise).then(() => tracker.section('after-a', async () => { order.push('after-a'); })),
      queue.suspendWhile(() => b.promise).then(() => tracker.section('after-b', async () => { order.push('after-b'); })),
    ]);
    return queue.status();
  });
  await settle();
  assert.equal(queue.status().suspendedWrites, 1);
  assert.equal(queue.status().activeLocks, 0);
  await queue.runWrite(['k'], async () => { order.push('between'); });
  a.open();
  await settle();
  b.open();
  const inside = await siblings;
  assert.equal(inside.activeWrites, 1);
  assert.equal(inside.suspendedWrites, 0);
  assert.deepEqual(order, ['between', 'after-a', 'after-b']);
  assert.deepEqual(tracker.violations, []);
  assertIdle(queue);
});

test('status coherente en cada fase y P3 cede solo ante demanda real', async () => {
  const queue = createSmartQueue({ backgroundYieldMs: 1 });
  assert.equal(await queue.yieldIfNeeded(), false);
  const user = gate();
  const held = gate();
  const heldStarted = gate();
  const w1 = queue.runWrite(['k'], async () => {
    heldStarted.open();
    await held.promise;
    await queue.suspendWhile(() => user.promise);
  });
  await heldStarted.promise;
  const w2 = queue.runWrite(['k'], async () => {});
  await settle();
  assert.deepEqual(
    (({ activeWrites, queuedWrites, suspendedWrites, activeLocks }) => ({ activeWrites, queuedWrites, suspendedWrites, activeLocks }))(queue.status()),
    { activeWrites: 1, queuedWrites: 1, suspendedWrites: 0, activeLocks: 1 },
  );
  assert.equal(queue.hasForegroundDemand(), true);
  assert.equal(await queue.yieldIfNeeded(), true);

  held.open();
  await w2;
  assert.deepEqual(
    (({ activeWrites, queuedWrites, suspendedWrites, activeLocks }) => ({ activeWrites, queuedWrites, suspendedWrites, activeLocks }))(queue.status()),
    { activeWrites: 0, queuedWrites: 0, suspendedWrites: 1, activeLocks: 0 },
  );
  // Con la única escritura esperando al usuario, el fondo avanza sin esperar.
  assert.equal(await queue.runBackground(() => 'bg', { maxWaitMs: 60_000 }), 'bg');
  user.open();
  await w1;
  const status = queue.status();
  assert.equal(status.completedWrites, 2);
  assertIdle(queue);
});

test('waitForForegroundIdle se resuelve al quedar libre y retira su espera al cancelarse', async () => {
  const queue = createSmartQueue();
  const read = gate();
  const active = queue.runRead(() => read.promise);
  const idle = queue.waitForForegroundIdle({ maxWaitMs: 60_000 });
  const controller = new AbortController();
  const cancelled = queue.waitForForegroundIdle({ signal: controller.signal, maxWaitMs: 60_000 });
  controller.abort(new Error('fin'));
  await assert.rejects(cancelled, /fin/);
  read.open();
  await active;
  await idle;
  assertIdle(queue);
});

test('el trabajo de fondo que una lectura espera no cede ante esa misma lectura', async () => {
  const queue = createSmartQueue();
  let releaseRead;
  const reading = queue.runRead(() => new Promise((resolve) => { releaseRead = resolve; }));
  assert.equal(queue.hasForegroundDemand(), true);

  // Sin prisa, el fondo cede; el de otra carpeta sigue cediendo aunque esta tenga prisa.
  let other = 'cediendo';
  const otherWait = queue.waitForForegroundIdle({ key: 'carpeta-b', maxWaitMs: 60_000 }).then(() => { other = 'libre'; });
  let scan = 'cediendo';
  const scanWait = queue.waitForForegroundIdle({ key: 'carpeta-a', maxWaitMs: 60_000 }).then(() => { scan = 'libre'; });
  await Promise.resolve();
  assert.deepEqual([scan, other], ['cediendo', 'cediendo']);

  // La lectura declara que espera el recorrido de la carpeta A: ese recorrido avanza ya.
  const unhurry = queue.expedite('carpeta-a');
  await scanWait;
  assert.deepEqual([scan, other], ['libre', 'cediendo']);
  assert.equal(await queue.yieldIfNeeded({ key: 'carpeta-a' }), false);
  await queue.waitForForegroundIdle({ key: 'carpeta-a', maxWaitMs: 60_000 });

  // Con dos llamadas esperando, la prisa dura hasta que la última la retira (y retirarla dos veces no cuenta doble).
  const second = queue.expedite('carpeta-a');
  unhurry();
  unhurry();
  assert.equal(await queue.yieldIfNeeded({ key: 'carpeta-a', maxWaitMs: 1 }), false);
  second();
  assert.equal(await queue.yieldIfNeeded({ key: 'carpeta-a', maxWaitMs: 1 }), true);

  releaseRead();
  await reading;
  await otherWait;
  assert.equal(other, 'libre');
});

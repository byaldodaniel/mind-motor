#!/usr/bin/env node
import fs from 'node:fs/promises';
import { startCentralMotor } from '../src/motor-central.js';
import { openSession } from '../src/session.js';
import { productInstallation, productPaths, productRuntime } from '../src/layout.js';
import { releaseOf } from '../src/package-descriptor.js';
import { MOTOR_VERSION } from '../src/version.js';
import { readHandoff } from '../src/update-handoff-state.js';
import { inspectProcessOwners } from '../src/process-identity.js';
import { httpRequest } from '../src/connector.js';

let motor, timeout, parentWatch;
try {
  const options = JSON.parse(process.env.MIND_UPDATE_VERIFY ?? 'null');
  delete process.env.MIND_UPDATE_VERIFY;
  const installed = await productInstallation();
  const root = await fs.realpath(options.root);
  const marker = await readHandoff(root);
  if (installed.root !== root || marker?.id !== options.handoffId || marker.phase !== 'verificando'
      || marker.verificationToken !== options.verificationToken || !/^[a-f0-9]{64}$/u.test(options.verificationToken)
      || MOTOR_VERSION !== installed.manifest.mindVersion
      || JSON.stringify(releaseOf(installed.manifest)) !== JSON.stringify(options.release)) throw new Error('Verificación no ligada al candidato instalado.');
  const paths = productPaths(root, installed.manifest), runtime = productRuntime(root, installed.manifest);
  const layout = { product: true, root, manifest: installed.manifest, ...paths, runtime,
    baseDirectory: options.baseDirectory, pythonExecutable: runtime.pythonExecutable, protectedDirectories: [paths.programDirectory, paths.componentsDirectory] };
  const abort = () => { Promise.resolve(motor?.stop('verificacion-interrumpida')).finally(() => process.exit(1)); };
  timeout = setTimeout(abort, options.timeoutMs);
  parentWatch = setInterval(async () => {
    const [owner] = await inspectProcessOwners([options.parent], { pythonExecutable: options.pythonExecutable });
    if (owner?.state !== 'active') abort();
  }, 1_000);
  motor = await startCentralMotor({ layout, motorVersion: MOTOR_VERSION, preferredPort: 0,
    observe: false, discoverDelayMs: -1, updateRoot: null, idleLightMs: 0, idleShutdownMs: 0,
    verificationToken: options.verificationToken, publishConnector: false,
    sessionFactory: opts => openSession({ ...opts, installationLeaseHeld: true }),
  });
  if (motor.alreadyRunning) throw new Error('Otro Motor ocupa la Base durante la verificación.');
  const body = JSON.stringify({ accion: 'verificar-actualizacion' });
  const response = await httpRequest({ port: motor.port, method: 'POST', pathName: '/rpc',
    headers: { Authorization: `Bearer ${motor.token}`, 'X-Mind-Update-Verification': options.verificationToken, 'Content-Type': 'application/json' }, body });
  const result = JSON.parse(response.body);
  if (response.status !== 200 || result.ok !== true || result.baseDirectory !== await fs.realpath(options.baseDirectory)
      || result.baseId !== options.expectedBaseId || marker.baseIdentity !== options.expectedBaseId
      || JSON.stringify(result.release) !== JSON.stringify(options.release)) throw new Error('La lectura por RPC de la Base no coincide con la entrega.');
  await motor.stop('verificacion-completa'); motor = null;
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  await motor?.stop('verificacion-fallida').catch(() => {});
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
  process.exitCode = 1;
} finally { clearTimeout(timeout); clearInterval(parentWatch); }

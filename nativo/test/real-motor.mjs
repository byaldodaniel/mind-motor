import path from 'node:path';

import {resolveLayout} from '../../src/layout.js';
import {runCentralMotorDaemon} from '../../src/motor-central.js';
const base=process.argv[2];if(!base?.includes('mind-nativo-runs'))throw new Error('ISOLATION_REQUIRED');
const layout=await resolveLayout({base});
await runCentralMotorDaemon({layout,motorVersion:'1.0.4',discoverUpdates:null});

import path from 'node:path';
import { pathToFileURL } from 'node:url';
const WT = 'C:/Users/Aldo Daniel/Desktop/Mind - Desarrollo/Worktrees/1.0.5-etapa2';
const imp = (p) => import(pathToFileURL(path.join(WT, p)).href);
const { resolveLayout } = await imp('src/layout.js');
const { runCentralMotorDaemon } = await imp('src/motor-central.js');
const base = process.argv[2];
if (!base.includes('mind-medicion-')) throw new Error('ISOLATION_REQUIRED');
await runCentralMotorDaemon({ layout: await resolveLayout({ base }), motorVersion: '1.0.4', discoverUpdates: null });

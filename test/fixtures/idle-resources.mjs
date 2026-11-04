// Explicit preload for tests that verify background observation deadlines.
// The real MCP integration and production launchers never import this fixture.
import os from 'node:os';

let idleTicks = 0;
os.cpus = () => [{
  model: 'CPU ficticia en reposo', speed: 1000,
  times: { user: 0, nice: 0, sys: 0, idle: ++idleTicks, irq: 0 },
}];
os.freemem = () => os.totalmem();

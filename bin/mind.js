#!/usr/bin/env node
// Punto de entrada de Mind para el usuario y para agentes compatibles.
// Los iniciadores del paquete (mind, mind.cmd) lo ejecutan con el Node incluido.
import { launch } from '../src/auto-update.js';

process.exitCode = await launch(process.argv.slice(2));

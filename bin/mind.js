#!/usr/bin/env node
// Punto de entrada de Mind para el usuario y para agentes compatibles.
// Los iniciadores del paquete (mind, mind.cmd) lo ejecutan con el Node incluido.
import { main } from '../src/product-cli.js';

process.exitCode = await main(process.argv.slice(2));

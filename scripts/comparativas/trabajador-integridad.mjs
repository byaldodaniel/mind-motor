/**
 * Escritor de la prueba de integridad. Hace M actualizaciones del mismo
 * archivo: leer, "pensar" (espera aleatoria con semilla) y escribir el
 * contenido leído más una línea propia. Espera "YA" por stdin para empezar a
 * la vez que el otro escritor.
 *
 * Modos:
 *   directo          readFile + writeFile en el sitio (lo que hace un script o una herramienta sin control).
 *   directo-atomico  readFile + temporal + rename (sin pérdida parcial, pero sin control de versión).
 *   mind             readTextFile + modifyTextFile con la versión leída; ante VERSION_CONFLICT o
 *                    FILE_IN_USE vuelve a leer y reintenta.
 * Entrada (JSON en argv[2]): { modo, archivo, relativa, base, carpeta, id, actualizaciones, semilla, maxReintentos }.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { crearAzar } from './lib/azar.mjs';
import { esperar } from './lib/medir.mjs';

const entrada = JSON.parse(process.argv[2]);
const azar = crearAzar(entrada.semilla);
let motor = null;
let textVersion = null;
const solicitante = Object.freeze({ escritor: entrada.id });
if (entrada.modo === 'mind') {
  const modulo = await import('../../src/motor.js');
  motor = await modulo.openMotor({ baseDirectory: entrada.base });
  textVersion = modulo.textVersion;
}

async function leerConMind() {
  const permiso = await motor.grantTextRead({ requester: solicitante, folderId: entrada.carpeta, relativePath: entrada.relativa });
  return (await motor.readTextFile({ requester: solicitante, authorization: permiso })).content;
}

async function escribirConMind(contenido, version) {
  const permiso = await motor.grantTextModify({ requester: solicitante, folderId: entrada.carpeta, relativePath: entrada.relativa });
  return motor.modifyTextFile({ requester: solicitante, authorization: permiso, expectedVersion: version, content: contenido });
}

const lineas = readline.createInterface({ input: process.stdin });
process.stdout.write('LISTO\n');
await new Promise((resolver) => lineas.once('line', resolver));
lineas.close();

const resultado = { id: entrada.id, modo: entrada.modo, exitos: 0, conflictos: {}, reintentos: 0, abandonadas: 0, errores: {} };
const inicio = performance.now();
for (let k = 0; k < entrada.actualizaciones; k += 1) {
  const linea = `${entrada.id}-${k}\n`;
  if (entrada.modo === 'mind') {
    let hecho = false;
    for (let intento = 0; intento <= entrada.maxReintentos && !hecho; intento += 1) {
      if (intento > 0) resultado.reintentos += 1;
      try {
        const leido = await leerConMind();
        await esperar(azar.entero(0, 15));
        await escribirConMind(leido + linea, textVersion(leido));
        hecho = true;
      } catch (error) {
        const codigo = error?.code ?? 'ERROR';
        if (codigo === 'VERSION_CONFLICT' || codigo === 'FILE_IN_USE') {
          resultado.conflictos[codigo] = (resultado.conflictos[codigo] ?? 0) + 1;
          await esperar(azar.entero(0, 10));
        } else {
          resultado.errores[codigo] = (resultado.errores[codigo] ?? 0) + 1;
        }
      }
    }
    if (hecho) resultado.exitos += 1;
    else resultado.abandonadas += 1;
  } else {
    const leido = fs.readFileSync(entrada.archivo, 'utf8');
    await esperar(azar.entero(0, 15));
    if (entrada.modo === 'directo') {
      fs.writeFileSync(entrada.archivo, leido + linea);
    } else {
      const temporal = `${entrada.archivo}.${entrada.id}-${k}.tmp`;
      fs.writeFileSync(temporal, leido + linea);
      fs.renameSync(temporal, entrada.archivo);
    }
    resultado.exitos += 1;
  }
  await esperar(azar.entero(0, 5));
}
resultado.milisegundos = performance.now() - inicio;
process.stdout.write(`${JSON.stringify(resultado)}\n`);

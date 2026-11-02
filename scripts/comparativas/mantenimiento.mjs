import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearAzar } from './lib/azar.mjs';
import { estadisticas, carga, megas } from './lib/medir.mjs';
import { ejecutar } from './lib/sistema.mjs';

const MANTENIMIENTO = fileURLToPath(new URL('./trabajador-mantenimiento.mjs', import.meta.url));
const OBSERVADOR = fileURLToPath(new URL('./trabajador-observador.mjs', import.meta.url));

async function indexar(entrada) {
  const salida = await ejecutar(process.execPath, [MANTENIMIENTO, JSON.stringify(entrada)]);
  if (salida.codigo !== 0) throw new Error(`La indexación falló: ${salida.error.slice(0, 500)}`);
  return JSON.parse(salida.lineas.at(-1));
}

function resumenOperacion(lista) {
  return {
    milisegundos: estadisticas(lista.map((item) => item.milisegundos)),
    cpuPropioMs: estadisticas(lista.map((item) => item.cpu.propioMs)),
    cpuPythonMs: lista[0].cpu.hijosMs === null ? null : estadisticas(lista.map((item) => item.cpu.hijosMs)),
    rssMaximoMiB: estadisticas(lista.map((item) => item.rssMaximoMiB)),
  };
}

/** Compara los cambios informados por el indexador con los aplicados de verdad. */
function compararCambios(informados, aplicados) {
  const resultado = {};
  for (const clave of ['added', 'modified', 'removed']) {
    const vistos = new Set(informados?.[clave] ?? []);
    const esperados = aplicados[clave];
    let aciertos = 0;
    for (const ruta of vistos) if (esperados.has(ruta)) aciertos += 1;
    resultado[clave] = { esperados: esperados.size, informados: vistos.size, aciertos, falsos: vistos.size - aciertos, perdidos: esperados.size - aciertos };
  }
  return resultado;
}

/**
 * Coste de mantener el índice: indexación inicial, reconciliación sin cambios,
 * reconciliación tras N cambios y tiempo hasta que un cambio externo es
 * encontrable con el observador. Modifica el árbol (altas, cambios y bajas).
 */
export async function medirMantenimiento({ plan, raiz, base, carpeta, temporal, cambios = [10, 100, 1000],
  repeticionesInicial = 3, repeticionesSinCambios = 5, ensayosLatencia = 5, log = () => {} }) {
  const resultado = { carga: { inicio: carga() } };

  log('  indexación inicial (Base nueva en cada repetición)');
  const iniciales = [];
  for (let i = 0; i < repeticionesInicial; i += 1) {
    const nueva = fs.mkdtempSync(path.join(temporal, 'base-inicial-'));
    try {
      iniciales.push(await indexar({ base: nueva, raiz }));
    } finally {
      fs.rmSync(nueva, { recursive: true, force: true });
    }
  }
  resultado.inicial = {
    ...resumenOperacion(iniciales), entradas: iniciales[0].totales.entries, modo: iniciales[0].modo,
    indiceMiB: megas(iniciales[0].indiceBytes), bytesPorEntrada: Math.round(iniciales[0].indiceBytes / iniciales[0].totales.entries),
  };

  log('  reconciliación sin cambios');
  const sinCambios = [];
  for (let i = 0; i < repeticionesSinCambios; i += 1) sinCambios.push(await indexar({ base, carpeta }));
  resultado.sinCambios = {
    ...resumenOperacion(sinCambios),
    cambiosInformados: sinCambios.reduce((suma, item) => suma + item.cambios.added.length + item.cambios.modified.length + item.cambios.removed.length, 0),
  };

  // Altas, modificaciones y bajas reales, con la verdad de lo aplicado.
  const azar = crearAzar(`mantenimiento:${plan.total}`);
  const carpetas = plan.entradas.filter((entrada) => entrada.tipo === 'carpeta' && !entrada.oculta).map((entrada) => entrada.ruta);
  const archivos = plan.entradas.filter((entrada) => entrada.tipo === 'archivo').map((entrada) => entrada.ruta);
  const vivos = new Set(archivos);
  resultado.conCambios = [];
  for (const cantidad of cambios) {
    log(`  reconciliación tras ${cantidad} cambios`);
    const aplicados = { added: new Set(), modified: new Set(), removed: new Set() };
    const altas = Math.round(cantidad * 0.4);
    const modificaciones = Math.round(cantidad * 0.4);
    const bajas = cantidad - altas - modificaciones;
    const candidatos = [...vivos];
    const elegidos = new Set();
    const elegir = () => {
      for (;;) {
        const ruta = azar.elegir(candidatos);
        if (!elegidos.has(ruta)) {
          elegidos.add(ruta);
          return ruta;
        }
      }
    };
    for (let i = 0; i < modificaciones; i += 1) {
      const ruta = elegir();
      fs.appendFileSync(path.join(raiz, ...ruta.split('/')), `Cambio ficticio ${cantidad}-${i}.\n`);
      aplicados.modified.add(ruta);
    }
    for (let i = 0; i < bajas; i += 1) {
      const ruta = elegir();
      fs.rmSync(path.join(raiz, ...ruta.split('/')));
      vivos.delete(ruta);
      aplicados.removed.add(ruta);
    }
    for (let i = 0; i < altas; i += 1) {
      const ruta = `${azar.elegir(carpetas)}/nuevo ${cantidad}-${i} Revisión.txt`;
      fs.writeFileSync(path.join(raiz, ...ruta.split('/')), `Archivo ficticio nuevo ${i}.\n`, { flag: 'wx' });
      vivos.add(ruta);
      aplicados.added.add(ruta);
    }
    const medida = await indexar({ base, carpeta });
    resultado.conCambios.push({
      cambios: cantidad, milisegundos: Number(medida.milisegundos.toFixed(1)), cpu: medida.cpu,
      rssMaximoMiB: Number(medida.rssMaximoMiB.toFixed(1)), deteccion: compararCambios(medida.cambios, aplicados),
    });
  }

  log('  observador: tiempo hasta que un cambio externo es encontrable');
  const destino = carpetas.find((ruta) => ruta.split('/').length === 2) ?? carpetas[0];
  const latencia = await ejecutar(process.execPath, [OBSERVADOR, JSON.stringify({
    fase: 'latencia', base, carpeta, raiz, destino, ensayos: ensayosLatencia,
  })]);
  if (latencia.codigo !== 0) throw new Error(`El observador falló: ${latencia.error.slice(0, 500)}`);
  const datos = JSON.parse(latencia.lineas.at(-1));
  const serie = (accion, clave) => estadisticas(datos.ensayos.map((ensayo) => ensayo[accion]?.[clave]).filter((valor) => typeof valor === 'number'));
  resultado.observador = {
    observar: datos.observar,
    alta: { publicado: serie('alta', 'publicadoMs'), encontrable: serie('alta', 'encontrableMs') },
    modificacion: { publicado: serie('modificacion', 'publicadoMs'), encontrable: serie('modificacion', 'encontrableMs') },
    baja: { publicado: serie('baja', 'publicadoMs'), encontrable: serie('baja', 'encontrableMs') },
    coherentes: datos.ensayos.every((ensayo) => ['alta', 'modificacion', 'baja'].every((accion) => ensayo[accion]?.coherente === true)),
    informes: datos.informes,
  };
  resultado.carga.fin = carga();
  return resultado;
}

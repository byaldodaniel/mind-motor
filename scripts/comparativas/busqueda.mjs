import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdad } from './lib/arbol.mjs';
import { estadisticas, vaciarCache, puedeVaciarCache, carga } from './lib/medir.mjs';
import { ejecutar, argumentosFind, argumentosRg, relativas, disponible, contarLlamadas, restarLlamadas } from './lib/sistema.mjs';
import { iniciarMcp } from './lib/mcp.mjs';

const TRABAJADOR = fileURLToPath(new URL('./trabajador-busqueda.mjs', import.meta.url));

/** Consultas comparadas. La verdad sale del generador (forma canónica), no de Mind. */
export const CONSULTAS = Object.freeze([
  { id: 'informe', descripcion: 'Nombre con «informe» (mayúsculas variadas)', consulta: 'informe' },
  { id: 'informacion', descripcion: '«informacion» sin tilde (en disco: Información, INFORMACIÓN, informacion…)', consulta: 'informacion' },
  { id: 'informacion-con-tilde', descripcion: '«información» con tilde', consulta: 'información' },
  { id: 'acta-de-reunion', descripcion: '«acta de reunion» sin tilde, varias palabras', consulta: 'acta de reunion' },
  { id: 'nandu', descripcion: '«nandu» sin eñe ni tilde (cliente Ñandú Logística)', consulta: 'nandu' },
  {
    id: 'pdf-1s2025-1mib', descripcion: 'Filtro: .pdf, modificado en el 1.er semestre de 2025, ≥ 1 MiB', consulta: '',
    extension: '.pdf', desde: Date.UTC(2025, 0, 1), hasta: Date.UTC(2025, 6, 1), minBytes: 1_048_576,
  },
  {
    id: 'factura-pdf-2026', descripcion: 'Nombre con «factura» + .pdf + modificado desde 2026-01-01', consulta: 'factura',
    extension: '.pdf', desde: Date.UTC(2026, 0, 1),
  },
]);
/** Consultas con medición en frío (el coste en frío depende del recorrido, no de la consulta). */
const EN_FRIO = new Set(['informacion', 'pdf-1s2025-1mib']);

function peticionMind(consulta) {
  const peticion = {};
  if (consulta.consulta) peticion.query = consulta.consulta;
  if (consulta.extension) peticion.extensions = [consulta.extension];
  if (consulta.desde) peticion.modifiedAfter = new Date(consulta.desde).toISOString();
  if (consulta.hasta) peticion.modifiedBefore = new Date(consulta.hasta).toISOString();
  if (consulta.minBytes) peticion.minSize = consulta.minBytes;
  return peticion;
}

function argumentosBuscar(consulta) {
  const argumentos = { limite: 50 };
  if (consulta.consulta) argumentos.consulta = consulta.consulta;
  if (consulta.extension) argumentos.extensiones = [consulta.extension];
  if (consulta.desde) argumentos.modificado_desde = new Date(consulta.desde).toISOString();
  if (consulta.hasta) argumentos.modificado_hasta = new Date(consulta.hasta).toISOString();
  if (consulta.minBytes) argumentos.tamano_min = consulta.minBytes;
  return argumentos;
}

function criterioRecorrido(consulta, normalizar) {
  return {
    consulta: consulta.consulta, normalizar, extensiones: consulta.extension ? [consulta.extension] : null,
    desde: consulta.desde ?? null, hasta: consulta.hasta ?? null, minBytes: consulta.minBytes ?? null,
  };
}

function verdadDe(plan, consulta) {
  return verdad(plan, {
    consulta: consulta.consulta, extensiones: consulta.extension ? [consulta.extension] : null,
    desde: consulta.desde ?? null, hasta: consulta.hasta ?? null, minBytes: consulta.minBytes ?? null,
  });
}

/** Precisión y exhaustividad frente a la verdad conocida. */
export function evaluar(resultados, esperado) {
  const devueltos = new Set(resultados);
  let aciertos = 0;
  for (const ruta of devueltos) if (esperado.has(ruta)) aciertos += 1;
  return {
    esperados: esperado.size,
    devueltos: devueltos.size,
    aciertos,
    precision: devueltos.size === 0 ? (esperado.size === 0 ? 1 : 0) : Number((aciertos / devueltos.size).toFixed(4)),
    exhaustividad: esperado.size === 0 ? 1 : Number((aciertos / esperado.size).toFixed(4)),
  };
}

async function trabajador(entrada) {
  const salida = await ejecutar(process.execPath, [TRABAJADOR, JSON.stringify(entrada)]);
  if (salida.codigo !== 0) throw new Error(`Trabajador ${entrada.modo} falló: ${salida.error.slice(0, 500)}`);
  return { ...JSON.parse(salida.lineas.at(-1)), procesoMs: salida.milisegundos };
}

async function enFrioDeDisco(veces, tarea) {
  if (!puedeVaciarCache()) return null;
  const tiempos = [];
  for (let i = 0; i < veces; i += 1) {
    vaciarCache();
    tiempos.push(await tarea());
  }
  return tiempos;
}

/**
 * @param {{ plan: object, raiz: string, base: string, carpeta: string, repeticiones: number, frio: number, temporal: string, log: Function }} opciones
 */
export async function medirBusqueda({ plan, raiz, base, carpeta, repeticiones = 15, frio = 5, frioDisco = 3, temporal, log = () => {} }) {
  const hayFind = disponible('find');
  const hayRg = disponible('rg');
  const resultados = { carga: { inicio: carga() }, consultas: [] };

  for (const consulta of CONSULTAS) {
    log(`  búsqueda «${consulta.id}»`);
    const esperado = verdadDe(plan, consulta);
    const fila = { id: consulta.id, descripcion: consulta.descripcion, esperados: esperado.size, enfoques: {} };

    // Mind: searchFiles sobre el índice persistente, en el mismo proceso (caliente).
    const mind = await trabajador({ modo: 'mind', base, carpeta, peticion: peticionMind(consulta), repeticiones, calentamiento: 2, paginar: true });
    fila.enfoques.mind = {
      caliente: estadisticas(mind.tiempos), primeraLlamadaMs: Number(mind.primeraMs.toFixed(1)),
      abrirMotorMs: Number(mind.abrirMs.toFixed(1)), todasLasPaginasMs: Number(mind.todasMs.toFixed(1)), paginas: mind.paginas,
      operacionesPorBusqueda: mind.operaciones, recorridosDelArbol: 0, total: mind.total,
      calidad: evaluar(mind.todas, esperado), rssMiB: Number(mind.rssMiB.toFixed(1)),
    };
    if (EN_FRIO.has(consulta.id)) {
      const procesos = [];
      for (let i = 0; i < frio; i += 1) procesos.push(await trabajador({ modo: 'mind', base, carpeta, peticion: peticionMind(consulta) }));
      fila.enfoques.mind.frioProceso = {
        busqueda: estadisticas(procesos.map((item) => item.primeraMs)),
        abrirYBuscar: estadisticas(procesos.map((item) => item.abrirMs + item.primeraMs)),
        procesoCompleto: estadisticas(procesos.map((item) => item.procesoMs)),
      };
      const disco = await enFrioDeDisco(frioDisco, async () => {
        const item = await trabajador({ modo: 'mind', base, carpeta, peticion: peticionMind(consulta) });
        return { busqueda: item.primeraMs, proceso: item.procesoMs };
      });
      if (disco) {
        fila.enfoques.mind.frioDisco = {
          busqueda: estadisticas(disco.map((item) => item.busqueda)), procesoCompleto: estadisticas(disco.map((item) => item.proceso)),
        };
      }
    }

    // Alternativa JS: recorrido con readdir/stat (ingenuo: solo minúsculas; y con el mismo plegado que Mind).
    const recorrido = await trabajador({ modo: 'recorrido', raiz, criterio: criterioRecorrido(consulta, 'minusculas'), repeticiones, calentamiento: 1, devolver: true });
    const plegado = await trabajador({ modo: 'recorrido', raiz, criterio: criterioRecorrido(consulta, 'plegar'), devolver: true });
    fila.enfoques.recorridoJs = {
      caliente: estadisticas(recorrido.tiempos), primeraLlamadaMs: Number(recorrido.primeraMs.toFixed(1)),
      operaciones: recorrido.operaciones, entradasVistas: recorrido.entradasVistas, recorridosDelArbol: 1,
      calidad: evaluar(recorrido.todas, esperado), calidadConPlegado: evaluar(plegado.todas, esperado),
    };
    if (EN_FRIO.has(consulta.id)) {
      const disco = await enFrioDeDisco(frioDisco, async () => {
        const item = await trabajador({ modo: 'recorrido', raiz, criterio: criterioRecorrido(consulta, 'minusculas') });
        return { busqueda: item.primeraMs, proceso: item.procesoMs };
      });
      if (disco) {
        fila.enfoques.recorridoJs.frioDisco = {
          busqueda: estadisticas(disco.map((item) => item.busqueda)), procesoCompleto: estadisticas(disco.map((item) => item.proceso)),
        };
      }
    }

    // find del sistema (configuración regional del contenedor y C.UTF-8).
    if (hayFind) {
      const argumentos = argumentosFind(raiz, consulta);
      const tiempos = [];
      let primera = null;
      for (let i = 0; i < repeticiones + 1; i += 1) {
        const salida = await ejecutar('find', argumentos);
        if (i === 0) primera = salida;
        else tiempos.push(salida.milisegundos);
      }
      const utf8 = await ejecutar('find', argumentos, { env: { LC_ALL: 'C.UTF-8' } });
      fila.enfoques.find = {
        argumentos: argumentos.slice(1), caliente: estadisticas(tiempos), recorridosDelArbol: 1,
        calidad: evaluar(relativas(raiz, primera.lineas), esperado), calidadCUtf8: evaluar(relativas(raiz, utf8.lineas), esperado),
      };
      if (EN_FRIO.has(consulta.id)) {
        const disco = await enFrioDeDisco(frioDisco, async () => (await ejecutar('find', argumentos)).milisegundos);
        if (disco) fila.enfoques.find.frioDisco = { procesoCompleto: estadisticas(disco) };
      }
    }

    // rg --files: sin filtros de tamaño ni fecha (no aplica a esas consultas).
    if (hayRg && !consulta.minBytes && !consulta.desde) {
      for (const [clave, ocultos] of [['rg', false], ['rgOcultos', true]]) {
        const argumentos = argumentosRg(raiz, { consulta: consulta.consulta, extension: consulta.extension, ocultos });
        const tiempos = [];
        let primera = null;
        for (let i = 0; i < repeticiones + 1; i += 1) {
          const salida = await ejecutar('rg', argumentos);
          if (i === 0) primera = salida;
          else tiempos.push(salida.milisegundos);
        }
        fila.enfoques[clave] = {
          argumentos: argumentos.slice(0, -1), caliente: estadisticas(tiempos), recorridosDelArbol: 1,
          calidad: evaluar(relativas(raiz, primera.lineas), esperado),
        };
        if (!ocultos && EN_FRIO.has(consulta.id)) {
          const disco = await enFrioDeDisco(frioDisco, async () => (await ejecutar('rg', argumentos)).milisegundos);
          if (disco) fila.enfoques[clave].frioDisco = { procesoCompleto: estadisticas(disco) };
        }
      }
    } else if (hayRg) {
      fila.enfoques.rg = { noAplica: 'rg --files no filtra por tamaño ni fecha' };
    }
    resultados.consultas.push(fila);
  }

  // Llamadas al sistema de archivos con strace (una ejecución, restando el arranque del proceso).
  if (temporal) {
    log('  recuento de llamadas al sistema (strace)');
    const vacia = fs.mkdtempSync(path.join(temporal, 'vacia-'));
    const llamadas = {};
    const nodo = (entrada) => [TRABAJADOR, JSON.stringify(entrada)];
    for (const id of EN_FRIO) {
      const consulta = CONSULTAS.find((item) => item.id === id);
      const fila = {};
      fila.mind = restarLlamadas(
        contarLlamadas(process.execPath, nodo({ modo: 'mind', base, carpeta, peticion: peticionMind(consulta) }), { directorioTemporal: temporal }),
        contarLlamadas(process.execPath, nodo({ modo: 'mind-vacio', base }), { directorioTemporal: temporal }),
      );
      fila.recorridoJs = restarLlamadas(
        contarLlamadas(process.execPath, nodo({ modo: 'recorrido', raiz, criterio: criterioRecorrido(consulta, 'minusculas') }), { directorioTemporal: temporal }),
        contarLlamadas(process.execPath, nodo({ modo: 'recorrido-vacio' }), { directorioTemporal: temporal }),
      );
      if (hayFind) {
        fila.find = restarLlamadas(
          contarLlamadas('find', argumentosFind(raiz, consulta), { directorioTemporal: temporal }),
          contarLlamadas('find', argumentosFind(vacia, consulta), { directorioTemporal: temporal }),
        );
      }
      if (hayRg && !consulta.minBytes) {
        fila.rg = restarLlamadas(
          contarLlamadas('rg', argumentosRg(raiz, { consulta: consulta.consulta }), { directorioTemporal: temporal }),
          contarLlamadas('rg', argumentosRg(vacia, { consulta: consulta.consulta }), { directorioTemporal: temporal }),
        );
      }
      llamadas[id] = fila;
    }
    fs.rmSync(vacia, { recursive: true, force: true });
    resultados.llamadasAlSistema = llamadas;
  }

  // Mind por MCP, como lo ve el agente: la sesión reconcilia al empezar.
  log('  búsqueda por MCP (herramienta buscar)');
  const cliente = iniciarMcp({ base });
  try {
    const inicio = performance.now();
    await cliente.inicializar();
    const inicializarMs = performance.now() - inicio;
    const primera = await cliente.llamar('buscar', argumentosBuscar(CONSULTAS[1]));
    const mcp = {
      inicializarMs: Number(inicializarMs.toFixed(1)),
      primeraLlamada: { ms: Number(primera.milisegundos.toFixed(1)), desdeElInicioMs: Number((performance.now() - inicio).toFixed(1)), error: primera.datos?.error ?? null },
      consultas: {},
    };
    for (const consulta of CONSULTAS) {
      const tiempos = [];
      let ultima = null;
      for (let i = 0; i < Math.min(repeticiones, 10); i += 1) {
        ultima = await cliente.llamar('buscar', argumentosBuscar(consulta));
        tiempos.push(ultima.milisegundos);
      }
      mcp.consultas[consulta.id] = {
        caliente: estadisticas(tiempos), total: ultima.datos?.total ?? null, mostrados: ultima.datos?.mostrados ?? null,
        bytesRespuesta: ultima.bytes, bytesEstructurados: ultima.bytesEstructurados,
        bytesPorResultado: ultima.datos?.mostrados ? Math.round(ultima.bytesEstructurados / ultima.datos.mostrados) : null,
      };
    }
    resultados.mcp = mcp;
  } finally {
    await cliente.cerrar();
  }
  resultados.carga.fin = carga();
  return resultados;
}

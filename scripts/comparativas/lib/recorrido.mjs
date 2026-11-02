import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Alternativa directa sin Mind: recorrido recursivo con fs.readdir (tipos de
 * entrada del propio directorio, como find) y fs.stat solo para los archivos
 * que pasan el filtro de nombre y necesitan tamaño o fecha. Concurrencia
 * acotada, como hacen las bibliotecas de glob en Node. No sigue enlaces.
 */

/** Comparación ingenua: sin mayúsculas, como find -iname; no quita tildes ni normaliza. */
export function minusculas(texto) {
  return texto.toLowerCase();
}

/** Mismo plegado que usa Mind (NFD sin marcas, minúsculas). */
export function plegar(texto) {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * @param {string} raiz
 * @param {{ consulta?: string, normalizar?: (texto: string) => string, extensiones?: string[] | null,
 *   desde?: number | null, hasta?: number | null, minBytes?: number | null, maxBytes?: number | null,
 *   concurrencia?: number }} criterio
 * @returns {Promise<{ resultados: string[], operaciones: { readdir: number, stat: number }, entradasVistas: number }>}
 */
export async function recorrer(raiz, {
  consulta = '', normalizar = minusculas, extensiones = null, desde = null, hasta = null,
  minBytes = null, maxBytes = null, concurrencia = 16,
} = {}) {
  const aguja = normalizar(consulta);
  const exts = extensiones ? new Set(extensiones.map((item) => normalizar(item.startsWith('.') ? item : `.${item}`))) : null;
  const necesitaStat = desde !== null || hasta !== null || minBytes !== null || maxBytes !== null;
  const operaciones = { readdir: 0, stat: 0 };
  const resultados = [];
  const pendientes = [''];
  let entradasVistas = 0;
  let activos = 0;

  async function visitar(relativa) {
    const directorio = relativa === '' ? raiz : path.join(raiz, relativa);
    const hijos = await fs.readdir(directorio, { withFileTypes: true });
    operaciones.readdir += 1;
    for (const hijo of hijos) {
      entradasVistas += 1;
      const ruta = relativa === '' ? hijo.name : `${relativa}/${hijo.name}`;
      if (hijo.isDirectory()) {
        pendientes.push(ruta);
        continue;
      }
      if (!hijo.isFile()) continue;
      const nombre = normalizar(hijo.name);
      if (!nombre.includes(aguja)) continue;
      if (exts) {
        const punto = nombre.lastIndexOf('.');
        if (punto <= 0 || !exts.has(nombre.slice(punto))) continue;
      }
      if (necesitaStat) {
        const info = await fs.stat(path.join(directorio, hijo.name));
        operaciones.stat += 1;
        if (minBytes !== null && info.size < minBytes) continue;
        if (maxBytes !== null && info.size > maxBytes) continue;
        if (desde !== null && info.mtimeMs < desde) continue;
        if (hasta !== null && info.mtimeMs >= hasta) continue;
      }
      resultados.push(ruta);
    }
  }

  await new Promise((resolver, rechazar) => {
    let fallo = null;
    const avanzar = () => {
      if (fallo) return;
      while (activos < concurrencia && pendientes.length > 0) {
        activos += 1;
        visitar(pendientes.pop()).then(() => {
          activos -= 1;
          if (pendientes.length === 0 && activos === 0) resolver();
          else avanzar();
        }, (error) => {
          fallo = error;
          rechazar(error);
        });
      }
    };
    avanzar();
  });
  return { resultados, operaciones, entradasVistas };
}

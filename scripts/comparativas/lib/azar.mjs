/**
 * Generador pseudoaleatorio determinista (sfc32 sembrado con splitmix32).
 * La misma semilla produce la misma secuencia en cualquier sistema: las
 * comparativas no usan Math.random.
 */

function splitmix32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** Convierte un texto o número en una semilla de 32 bits estable. */
export function semillaDe(valor) {
  const texto = String(valor);
  let hash = 2166136261;
  for (let i = 0; i < texto.length; i += 1) {
    hash ^= texto.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * @param {number | string} semilla
 */
export function crearAzar(semilla) {
  const mezcla = splitmix32(typeof semilla === 'number' ? semilla : semillaDe(semilla));
  let a = mezcla();
  let b = mezcla();
  let c = mezcla();
  let d = mezcla();

  /** Número en [0, 1). */
  function siguiente() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const resultado = (t + d) | 0;
    c = (c + resultado) | 0;
    return (resultado >>> 0) / 4294967296;
  }

  const azar = {
    siguiente,
    /** Entero en [min, max], ambos incluidos. */
    entero(min, max) {
      return min + Math.floor(siguiente() * (max - min + 1));
    },
    /** Verdadero con probabilidad p. */
    si(p) {
      return siguiente() < p;
    },
    elegir(lista) {
      return lista[Math.floor(siguiente() * lista.length)];
    },
    /** Elige según pesos: [[valor, peso], ...]. */
    ponderado(pares) {
      let total = 0;
      for (const [, peso] of pares) total += peso;
      let objetivo = siguiente() * total;
      for (const [valor, peso] of pares) {
        objetivo -= peso;
        if (objetivo < 0) return valor;
      }
      return pares[pares.length - 1][0];
    },
    /** Normal estándar (Box-Muller). */
    normal() {
      const u = Math.max(siguiente(), 1e-12);
      const v = siguiente();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** Log-normal con mediana `mediana` y dispersión `sigma`, acotada a [min, max]. */
    lognormal(mediana, sigma, min, max) {
      const valor = Math.round(mediana * Math.exp(sigma * azar.normal()));
      return Math.min(max, Math.max(min, valor));
    },
    /** Subgenerador independiente y estable para una etiqueta. */
    derivar(etiqueta) {
      return crearAzar(semillaDe(`${a}:${b}:${etiqueta}`));
    },
  };
  return azar;
}

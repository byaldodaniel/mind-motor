/**
 * Proceso auxiliar de las comparativas de búsqueda. Recibe un JSON como único
 * argumento y escribe otro JSON en stdout. Se ejecuta en un proceso propio para
 * medir el arranque en frío y para contar llamadas al sistema con strace.
 *
 * Modos:
 *   mind             motor.searchFiles sobre el índice persistente.
 *   mind-vacio       solo abre el Motor (línea base de strace).
 *   recorrido        recorrido recursivo con fs.readdir/fs.stat.
 *   recorrido-vacio  solo carga el módulo (línea base de strace).
 */
const entrada = JSON.parse(process.argv[2]);

function salir(valor) {
  process.stdout.write(`${JSON.stringify(valor)}\n`);
}

if (entrada.modo === 'mind' || entrada.modo === 'mind-vacio') {
  const contador = await import('./lib/contador-fs.mjs');
  const { openMotor } = await import('../../src/motor.js');
  const inicioAbrir = performance.now();
  const motor = await openMotor({ baseDirectory: entrada.base });
  const abrirMs = performance.now() - inicioAbrir;
  if (entrada.modo === 'mind-vacio') {
    salir({ abrirMs });
  } else {
    const peticion = { folderIds: [entrada.carpeta], ...entrada.peticion };
    const antes = contador.instantanea();
    const inicio = performance.now();
    const primera = await motor.searchFiles(peticion);
    const primeraMs = performance.now() - inicio;
    const operaciones = contador.diferencia(antes, contador.instantanea());
    for (let i = 0; i < (entrada.calentamiento ?? 0); i += 1) await motor.searchFiles(peticion);
    const tiempos = [];
    for (let i = 0; i < (entrada.repeticiones ?? 0); i += 1) {
      const t = performance.now();
      await motor.searchFiles(peticion);
      tiempos.push(performance.now() - t);
    }
    let todas = null;
    let todasMs = null;
    let paginas = 0;
    if (entrada.paginar) {
      // Para la precisión hacen falta todas las páginas (máximo 500 resultados por llamada).
      todas = [];
      const t = performance.now();
      for (let offset = 0; ; offset += 500) {
        const pagina = await motor.searchFiles({ ...peticion, limit: 500, offset });
        paginas += 1;
        todas.push(...pagina.results.map((resultado) => resultado.relativePath));
        if (!pagina.truncated) break;
      }
      todasMs = performance.now() - t;
    }
    salir({
      abrirMs, primeraMs, tiempos, operaciones, total: primera.total, mostrados: primera.results.length,
      scope: primera.scopes[0], todas, todasMs, paginas, rssMiB: process.memoryUsage().rss / 1048576,
    });
  }
} else if (entrada.modo === 'recorrido' || entrada.modo === 'recorrido-vacio') {
  const { recorrer, minusculas, plegar } = await import('./lib/recorrido.mjs');
  if (entrada.modo === 'recorrido-vacio') {
    salir({});
  } else {
    const criterio = { ...entrada.criterio, normalizar: entrada.criterio.normalizar === 'plegar' ? plegar : minusculas };
    const inicio = performance.now();
    const primera = await recorrer(entrada.raiz, criterio);
    const primeraMs = performance.now() - inicio;
    for (let i = 0; i < (entrada.calentamiento ?? 0); i += 1) await recorrer(entrada.raiz, criterio);
    const tiempos = [];
    for (let i = 0; i < (entrada.repeticiones ?? 0); i += 1) {
      const t = performance.now();
      await recorrer(entrada.raiz, criterio);
      tiempos.push(performance.now() - t);
    }
    salir({
      primeraMs, tiempos, operaciones: primera.operaciones, entradasVistas: primera.entradasVistas,
      todas: entrada.devolver ? primera.resultados : null, total: primera.resultados.length,
      rssMiB: process.memoryUsage().rss / 1048576,
    });
  }
} else {
  throw new Error(`Modo desconocido: ${entrada.modo}`);
}

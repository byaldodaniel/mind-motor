# Búsqueda con y sin índice validado en memoria — Windows, 2026-11-01

`scripts/comparativas/cache-busqueda.mjs`, árbol ficticio reproducible (semilla
fija), medido desde la herramienta `buscar` del agente. Datos completos en
[cache-busqueda-90k-win32-2026-11-01.json](cache-busqueda-90k-win32-2026-11-01.json).

- Equipo: Intel Core i7-7500U (4 hilos), Windows 10 x64, Node 24.18.0, Python 3.12.10, NTFS.
- Árbol: 90 000 entradas; consulta `informe`; verdad conocida: 2 186 coincidencias.
- 10 repeticiones; se informa la mediana (p95 entre paréntesis).

| Medida | Sin caché | Con caché |
|---|---|---|
| Indexación inicial | 8,6 s | 4,4 s |
| Primera búsqueda | 15,5 s | 7,2 s |
| Búsqueda repetida | 2 508 ms (3 370) | 150 ms (161) |
| Dos agentes simultáneos | 4 963 ms | 293 ms |
| Búsqueda tras un cambio externo y reconciliación | 3 720 ms | 1 383 ms |
| Exhaustividad | 100 % | 100 % |
| Tras revocar la carpeta | `ACCESS_NOT_GRANTED` | `ACCESS_NOT_GRANTED` |
| Memoria (heap) añadida | 112,6 MB | 40,0 MB |

Referencia directa: `find -iname` (Git for Windows) 1 511 ms (1 923), 100 %.
`rg` no está instalado en este equipo.

## Por qué no 100 000 entradas

Con `--entradas 100000` la indexación se rechaza con `INDEX_LIMIT_EXCEEDED`:
el Motor limita cada carpeta a 100 000 entradas indexables (`DEFAULT_MAX_ENTRIES`
en `src/indexer.js`) y el árbol de la comparativa llega exactamente a ese número
sin contar la raíz. Es el límite del producto, no un fallo de plataforma. No se
ha cambiado: subirlo o medir por debajo de él es una decisión de producto
pendiente. Esta medición usa 90 000 entradas para quedar dentro del límite.

## Corrección necesaria para medir en Windows

El generador crea los archivos no textuales con su tamaño lógico mediante
`ftruncate`. En Linux son dispersos; en NTFS reservaban el tamaño real (331 GB
lógicos para 100 000 entradas) y la escritura fallaba con `ENOSPC`.
`scripts/comparativas/lib/arbol.mjs` los marca ahora como dispersos
(`FSCTL_SET_SPARSE`) antes de fijar su tamaño, en un único proceso de Python.

## Límites

Una sola máquina y una sola ejecución por modalidad; los tiempos dependen del
disco y de la carga del equipo. No se ha medido en macOS ni repetido en Linux
con esta versión.

# Incremento 09 — búsqueda mediante índices

Núcleo de la Función 02, *Encontrar y acceder a la información*: localizar
archivos con los índices persistentes de Mind, sin recorrer de nuevo las carpetas
originales en cada búsqueda. Rama `incremento-09-busqueda-indices`, creada desde
`main` `c9d06bf` (PR #7), en un clon independiente. Se entrega mediante PR sin
fusionar.

## Qué se implementó

- `src/search.js`: validación de la petición, coincidencia, filtros, orden y
  paginación sobre índices ya guardados.
- `Motor.searchFiles(request)`: operación del anfitrión, creada con el
  `readFolderIndex` del indexador y el `loadAuthorizedFolder` del registro.
- Sin cambios en el lector seguro, el indexador ni el adaptador MCP.

```js
const response = await motor.searchFiles({
  folderIds: [idCarpetaA, idCarpetaB], // ámbitos que el anfitrión autoriza
  query: 'informe',                    // opcional
  match: 'contains',                   // contains | prefix | exact
  field: 'name',                       // name | path
  types: ['file'],                     // por defecto solo archivos
  extensions: ['.md', 'pdf'],
  pathPrefix: 'Proyectos',
  minSize: 0, maxSize: 1_000_000,
  modifiedAfter: '2026-01-01T00:00:00Z', modifiedBefore: '2026-07-01T00:00:00Z',
  includeUnverified: true,
  sort: 'relevance',                   // relevance | path | modified | size
  limit: 50, offset: 0,
});
```

La respuesta es `{ results, total, offset, limit, truncated, scopes }`.

### Coincidencias

La comparación ignora mayúsculas y diacríticos (`informacion` encuentra
`Información`) tras normalizar Unicode. `contains` es la coincidencia parcial;
`prefix` y `exact` la restringen. `field: 'path'` compara con la ruta relativa.
Sin `query` coinciden todos los nombres y deciden los filtros. `pathPrefix` es
exacto y limita a una subcarpeta de cada ámbito. Los filtros de tamaño y fecha
excluyen las entradas que no tienen ese dato.

### Resultados y referencias

Cada resultado es `{ folderId, relativePath, name, type, size, modifiedAt,
changedAt, createdAt, status, reason, indexedAt }`. No incluye la ruta absoluta
ni contenido. `folderId` + `relativePath` es exactamente la entrada de
`grantTextRead`: un agente podrá elegir un resultado y el anfitrión decidir si
concede su lectura. La búsqueda por sí sola **no concede lectura**; una prueba lo
verifica.

### Vigencia

- `status: 'indexed'`: la entrada se confirmó en el recorrido de `indexedAt`.
  No garantiza que siga igual después de esa fecha.
- `status: 'unverified'`: el último recorrido no pudo confirmarla (por ejemplo,
  carpeta sin permiso); `reason` da el código. `includeUnverified: false` las excluye.
- Cada ámbito informa `scopes[i] = { folderId, status, indexedAt,
  indexGeneration, complete, code }`. `complete: false` indica carpetas sin
  listar, entradas sin verificar o incidencias en ese índice.

### Ámbitos y autorizaciones

No hay permisos nuevos. El anfitrión indica los ids (1 a 64, sin repetir) y la
vigencia se comprueba con el registro existente:

| Estado del ámbito | Cuándo |
|---|---|
| `searched` | Índice vigente y ligado a la autorización actual. |
| `not-indexed` | Sin índice, índice v1 o índice de una autorización anterior. |
| `not-authorized` | Carpeta retirada o cuya autorización cambió, también entre la lectura del índice y la respuesta. |
| `index-unavailable` | Índice dañado o enlazado; `code` lo indica. Los demás ámbitos siguen buscándose. |

En los tres últimos casos no se devuelve ninguna entrada de ese ámbito. Una
petición inválida falla completa con `INVALID_SEARCH` o `INVALID_SCOPE_ID` antes
de leer índices.

### Límites y orden

`limit` por defecto 50 y máximo 500; `offset` para paginar; `total` y
`truncated` informan lo omitido. El orden es total y determinista, independiente
del orden de `folderIds`:

- `relevance`: nombre igual a la consulta, luego empieza por ella, luego la
  contiene; desempate por nombre normalizado, ruta y `folderId`.
- `path`: ruta relativa y `folderId`.
- `modified` y `size`: de mayor a menor; los desconocidos al final; mismo desempate.

## Pruebas

`npm test` en Windows, Node.js 24.18.0 y Python 3.12, con datos ficticios en
carpetas `.mind-search-test-*` hermanas del Motor:

- JavaScript: **99 pruebas, 98 aprobadas, 0 fallos, 1 omitida** (FIFO, POSIX).
  Son 88 de regresión y 11 nuevas en `test/search.test.js`.
- Python lectura: 10 aprobadas. Python indexación: 11 aprobadas, 1 omitida (POSIX).

Se comprueba: nombre parcial sin mayúsculas ni acentos; modos, campo de ruta y
tipos; extensión, tamaño y fecha; orden determinista con ámbitos en cualquier
orden; paginación completa; validación; búsqueda sin intérprete y con los
originales movidos (sin recorrer ni abrir); carpeta retirada, reautorizada con un
índice viejo restaurado y reindexada; retirada entre lectura y respuesta;
resultados no confirmados; ámbitos sin índice o dañados junto a uno válido; y que
un resultado sirve para `grantTextRead` + `readTextFile` solo tras el permiso
explícito. Los resultados de macOS y Linux son los de los checks de la PR.

## Límites

- Cada búsqueda lee y valida los índices completos de los ámbitos pedidos; no hay
  un índice invertido ni caché. Adecuado para el tamaño de índice actual
  (100 000 entradas por carpeta como máximo).
- Los resultados reflejan el último recorrido; para datos actuales hay que
  reconciliar antes con `indexFolder`. No hay actualización por eventos.
- No se busca por contenido, etiquetas ni similitud.
- La normalización no trata equivalencias de compatibilidad (p. ej. ligaduras)
  ni reglas de idioma específicas.

## Qué falta para conectarla con el adaptador MCP

1. Decidir en el contrato del adaptador qué ámbitos de búsqueda aprueba el
   operador en el lanzador local de confianza; el agente no debe elegir ids ni
   recibir `searchFiles` con ámbitos arbitrarios.
2. Exponer una herramienta de búsqueda cuyo handler llame a `searchFiles` con
   esos ids fijados por el lanzador y solo los parámetros de búsqueda del agente.
3. Definir la selección: el agente elige un resultado (`folderId`,
   `relativePath`) y el anfitrión, con aprobación explícita, llama a
   `grantTextRead`; después aplica el flujo actual de `mind_read_text`.
4. Decidir qué campos de metadatos se entregan al modelo y cómo se marca
   `unverified` en la respuesta MCP.
5. Pruebas del puente con un cliente real, sin cambiar este núcleo.

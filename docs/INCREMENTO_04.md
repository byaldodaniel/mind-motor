# Incremento 04 — núcleo de indexación

Primera parte técnica de la Función 01, *Indexar automáticamente*. Se desarrolla
en paralelo al Incremento 03, en la rama `incremento-04-nucleo-indexacion` creada
desde `main` (`3a60bfa`, cierre del Incremento 02). No se fusiona ni se conecta
todavía a la API pública del Motor.

## Qué se implementó

Tres módulos nuevos, sin dependencias externas ni cambios en archivos existentes:

| Módulo | Responsabilidad |
|---|---|
| `src/index-scan.js` | Comprobar la raíz y recorrer metadatos: `opendir` y `lstat`, nada más. |
| `src/index-store.js` | Guardar, validar, recuperar y retirar índices en la Base. |
| `src/indexer.js` | Orquestar: ámbito autorizado, recorrido, reconciliación y publicación. |

- **Indexación inicial** de una carpeta: rutas relativas (separadas por `/`), tipo
  (`file`, `directory`, `link`, `other`), tamaño de archivos regulares y fechas de
  modificación, cambio de metadatos y creación (`null` si el sistema no la informa).
- **Persistencia** en `folder-index-<id>.json` dentro de la Base, con formato
  versionado `mind-folder-index` v1, escritura atómica del núcleo existente,
  generación creciente y fechas de creación y última actualización.
- **Reconciliación**: un nuevo recorrido completo se compara con el índice anterior
  y devuelve rutas añadidas, modificadas (tipo, tamaño o fecha de modificación) y
  eliminadas. Las carpetas no se informan como modificadas solo porque cambió su
  fecha: el cambio aparece en sus hijos.
- **Recuperación tras reinicio**: `readFolderIndex` lee el último índice sin
  recorrer la carpeta; una reconciliación posterior parte de él.
- **Errores, enlaces y accesos** tratados de forma explícita (ver abajo).
- Si cualquier paso falla, el índice anterior permanece intacto; nunca se publica
  un índice parcial.

No se calculan hashes, no se abre ni lee el contenido de los documentos y no se
copian, mueven ni modifican originales.

## Interfaz y frontera de autorización

```js
import { createFolderIndexer } from './indexer.js'; // módulo interno, no exportado

const indexer = createFolderIndexer({ baseDirectory, resolveScope, maxEntries });
await indexer.indexFolder(scopeId);      // inicial o reconciliación
await indexer.readFolderIndex(scopeId);  // FolderIndex | null
await indexer.removeFolderIndex(scopeId); // boolean
```

El indexador **no acepta rutas** de quien lo llama, solo el id de un ámbito
(64 hexadecimales, el formato de las carpetas del Incremento 02). La ruta la
aporta `resolveScope(scopeId)`, una función que solo el Motor proporciona y que
debe rechazar ámbitos no autorizados o retirados. El indexador además:

- exige que el resolutor devuelva el mismo id y una ruta absoluta;
- rechaza un ámbito que contenga la Base o esté dentro de ella;
- comprueba que la raíz existe, es un directorio y no está redirigida por un
  enlace propio ni de sus ancestros (`realpath` igual a la ruta registrada);
- vuelve a consultar la autorización al terminar el recorrido: si se retiró
  mientras tanto, no publica el índice.

`package.json` sigue exportando solo `src/motor.js`, y `Motor` no expone el
indexador, por lo que hoy no existe una operación pública de indexación. Las
pruebas usan un adaptador con `listAuthorizedFolders()` del Incremento 02.

`readFolderIndex` también exige la autorización vigente. `removeFolderIndex`
no la exige, para limpiar el índice de una carpeta ya retirada.

### Resultado de `indexFolder`

```js
{
  scopeId, mode: 'initial' | 'reconciliation', generation, indexedAt,
  totals: { entries, files, directories, links, other, notListed, unverified },
  changes: null | { added: string[], modified: string[], removed: string[] },
  issues: [{ path, code }],
}
```

`changes` es `null` en la indexación inicial para no confundir un primer
inventario con altas.

## Errores, enlaces y carpetas inaccesibles

| Situación | Comportamiento |
|---|---|
| Enlace simbólico o junction | Se registra como `link`, sin seguirlo ni guardar su destino. |
| FIFO, socket o dispositivo | Se registra como `other` solo con `lstat`; no se abre. |
| Subcarpeta que no se puede listar | Estado `not-listed` con el código del sistema; sus entradas anteriores pasan a `unverified` y **no se informan como eliminadas**. |
| Metadatos ilegibles de una entrada | Estado `unverified`; conserva el último registro o queda como `unknown`. |
| Entrada que desaparece durante el recorrido | Se omite: es una eliminación real. |
| Directorio sustituido mientras se lista | Se descarta su listado (`ECHANGED`) comparando dispositivo e inode antes y después. |
| Directorio de otro volumen o montaje | Estado `not-listed`, `OTHER_VOLUME`; no se recorre. |
| Nombre que no es UTF-8 válido (Linux) | Incidencia `NAME_NOT_UTF8` en su carpeta; no se inventa una ruta. |
| Raíz inexistente o no listable | `SCOPE_UNAVAILABLE`; índice anterior intacto. |
| Raíz redirigida o sustituida | `SCOPE_CHANGED`; índice anterior intacto. |
| Más entradas que `maxEntries` (100 000 por defecto) | `INDEX_LIMIT_EXCEEDED`; no se publica nada. |
| Índice dañado o enlazado | `INDEX_CORRUPT`, `RECORD_CORRUPT` o `RECORD_LINK`; no se repara ni se sobrescribe. |
| Otra instancia publicó durante el recorrido | `INDEX_CONFLICT`; se puede repetir la operación. |

Errores nuevos: `INVALID_SCOPE_RESOLVER`, `INVALID_INDEX_LIMIT`, `INVALID_SCOPE_ID`,
`INVALID_SCOPE`, `SCOPE_OVERLAPS_INTERNAL`, `SCOPE_UNAVAILABLE`, `SCOPE_CHANGED`,
`INDEX_LIMIT_EXCEEDED`, `INDEX_CORRUPT`, `INDEX_INVALID`, `INDEX_CONFLICT`.
Los errores del resolutor (por ejemplo `FOLDER_NOT_AUTHORIZED`) se propagan sin cambios.

## Indexación inicial, reconciliación y eventos

- **Inicial**: primer recorrido completo de un ámbito sin índice previo.
- **Reconciliación**: recorrido completo posterior, ejecutado cuando el Motor lo
  invoca. Detecta lo ocurrido entre dos ejecuciones, no en el momento en que ocurre.
- **Actualización por eventos**: **no implementada.** No hay vigilancia de
  archivos ni servicio residente; los cambios solo se conocen en la siguiente
  reconciliación.

## Pruebas

`npm test` en Windows, Node.js v24.18.0: **46 pruebas, 45 aprobadas, 0 fallos y
1 omitida**. Son las 27 de regresión de `main` y 19 nuevas en
`test/indexer.test.js`; la omitida es la del FIFO, solo POSIX, que correrá en macOS
y Linux en GitHub Actions. Los resultados en esos sistemas no se anticipan aquí.

Se comprueban: índice inicial con tipos, tamaños y fechas; ausencia de lectura de
contenido y de escritura, copia o movimiento de originales (instrumentando `fs`
y comparando bytes y fechas); altas, cambios, bajas, cambio de tipo, cambio con
el mismo tamaño y bajas de subárboles; recuperación y reconciliación en procesos
separados; enlaces de directorio (junction en Windows) y de archivo (POSIX) sin
seguir ni guardar destino; subcarpeta y metadatos inaccesibles (EACCES/EPERM
simulados) sin falsas bajas; otro volumen; sustitución durante el listado;
nombres no UTF-8; raíz desaparecida, redirigida o no listable; ámbitos no
autorizados, falsificados o solapados con la Base; retirada antes y durante la
indexación; límite de entradas; índices corruptos y enlazados; serialización y
conflicto entre instancias; índices independientes por ámbito.

Todos los datos son ficticios, en carpetas `.mind-index-test-*` hermanas del
Motor, fuera de Git y de cualquier Base personal, eliminadas al terminar.

## Limitaciones

- El recorrido es por rutas (`opendir` + `lstat`), no por descriptores como la
  lectura segura del Incremento 03. La comparación de inode antes y después reduce,
  pero no elimina, la carrera entre comprobar y listar. Como en el Incremento 02,
  el proceso local, la Base y el sistema de archivos se consideran de confianza.
  En el peor caso se registrarían nombres y metadatos ajenos, nunca contenido.
- Sin hashes, un cambio que conserve tamaño y fecha de modificación no se detecta.
  La fecha se guarda con precisión de milisegundos.
- Cada reconciliación recorre todo el ámbito y guarda el índice en un único JSON.
  Adecuado para carpetas personales; el límite configurable evita crecer sin control.
- En sistemas sin distinción de mayúsculas, renombrar solo mayúsculas aparece como
  baja y alta. macOS puede devolver nombres en NFD; se guardan tal como llegan.
- La serialización por ámbito vale dentro de una instancia. Entre procesos solo se
  detecta el conflicto por generación justo antes de escribir; no hay bloqueo.
- Los elementos de solo nube (p. ej. OneDrive) se registran con los metadatos que
  informe el sistema; listar una carpeta podría pedir al proveedor su contenido.
- Retirar una carpeta en el Incremento 02 no elimina hoy su índice: la integración
  deberá llamar a `removeFolderIndex`.

## Qué se necesita para conectarlo al Motor oficial

1. Cerrar el Incremento 03 y decidir la forma de integración.
2. Crear el indexador dentro de `openMotor` con la Base física y un resolutor
   basado en el cargador interno de autorizaciones (`loadAuthorizedFolder` en la
   rama del Incremento 03), sin aceptar rutas.
3. Decidir quién puede invocar `indexFolder`/`readFolderIndex`: solo el anfitrión
   administrativo, o agentes con un permiso explícito equivalente al de lectura.
4. Encadenar la retirada de carpetas con `removeFolderIndex`.
5. Opcionalmente, recorrer mediante el auxiliar nativo del Incremento 03 para
   eliminar la carrera de rutas.
6. Exponer comandos de CLI y actualizar `README.md` e `INTERFACES.md`.
7. La actualización por eventos queda para un incremento posterior.

# Incremento 04 — núcleo de indexación

Primera parte técnica de la Función 01, *Indexar automáticamente*. Se desarrolló
en paralelo al Incremento 03 y se rebasó sobre `main` después de su cierre
(`d56f9d9`, PR #3). Se entrega en la rama `incremento-04-nucleo-indexacion`
mediante una PR sin fusionar. No se conecta todavía a la API pública del Motor.

## Qué se implementó

| Archivo | Responsabilidad |
|---|---|
| `src/native_index.py` | Recorrido de metadatos por referencias de directorio (auxiliar Python, solo biblioteca estándar). |
| `src/index-scan.js` | Ejecutar el auxiliar y convertir sus registros en entradas del índice. |
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
- Si cualquier paso falla, el índice anterior permanece intacto; nunca se publica
  un índice parcial.

No se calculan hashes, no se abren archivos regulares ni se lee su contenido y no
se copian, mueven ni modifican originales.

## Recorrido por referencias

Los nombres de archivos son información privada: el índice no puede registrar
nombres de fuera de la carpeta autorizada, ni siquiera por una carrera entre
comprobar una ruta y listarla. Por eso el recorrido no resuelve rutas completas:

- **macOS/Linux:** se parte de `/` y se abre cada componente de la raíz con
  `os.open(dir_fd=..., O_DIRECTORY | O_NOFOLLOW)`, equivalente a `openat`. Cada
  carpeta se lista con `os.scandir(fd)` y cada hijo se consulta con
  `os.stat(nombre, dir_fd=fd, follow_symlinks=False)`. Una subcarpeta se abre
  respecto al descriptor de su padre y se exige, con `fstat`, que sea el mismo
  dispositivo e inode registrados al listarla.
- **Windows:** se abre la raíz del volumen local y cada componente con
  `NtCreateFile`, `RootDirectory`, un único nombre, `FILE_DIRECTORY_FILE` y
  `FILE_OPEN_REPARSE_POINT`; se rechaza cualquier handle con atributo de reparse.
  La carpeta se enumera desde ese mismo handle con `GetFileInformationByHandleEx`
  (`FileFullDirectoryInfo`), que ya devuelve tipo, tamaño y fechas de los hijos.

Las referencias de la raíz y de los ancestros en curso se mantienen abiertas: si
alguien renombra la raíz o una carpeta intermedia y deja en su lugar un enlace
hacia fuera, el recorrido continúa en el objeto ya adquirido. Si una carpeta hija
se sustituye por un enlace o por otro objeto antes de abrirla, no se lista
(`ECHANGED`). Solo se abren carpetas; FIFOs, dispositivos y archivos no se abren.

**Denegación conservadora:** no existe alternativa por rutas. Si Python, las
primitivas por descriptor o el tipo de volumen no están disponibles, la operación
falla con `SAFE_SCAN_UNAVAILABLE` y no se escribe nada. En Windows solo se admiten
volúmenes locales fijos con letra, igual que en la lectura segura.

## Interfaz y frontera de autorización

```js
import { createFolderIndexer } from './indexer.js'; // módulo interno, no exportado

const indexer = createFolderIndexer({ baseDirectory, resolveScope, maxEntries, pythonExecutable });
await indexer.indexFolder(scopeId);       // inicial o reconciliación
await indexer.readFolderIndex(scopeId);   // FolderIndex | null
await indexer.removeFolderIndex(scopeId); // boolean
```

El indexador **no acepta rutas** de quien lo llama, solo el id de un ámbito
(64 hexadecimales, el formato de las carpetas del Incremento 02). La ruta la
aporta `resolveScope(scopeId)`, una función que solo el Motor proporciona y que
debe rechazar ámbitos no autorizados o retirados. El indexador además exige que
el resolutor devuelva el mismo id y una ruta absoluta, rechaza un ámbito que
contenga la Base o esté dentro de ella y vuelve a consultar la autorización al
terminar el recorrido: si se retiró mientras tanto, no publica el índice.

`package.json` sigue exportando solo `src/motor.js`, y `Motor` no expone el
indexador: hoy no existe una operación pública de indexación. Las pruebas usan un
adaptador con `listAuthorizedFolders()` del Incremento 02. `readFolderIndex` exige
la autorización vigente; `removeFolderIndex` no, para limpiar el índice de una
carpeta ya retirada.

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
| Otro reparse point de carpeta (Windows) | `not-listed`, `REPARSE_POINT`; no se recorre. |
| FIFO, socket o dispositivo | Se registra como `other` por sus metadatos; no se abre. |
| Subcarpeta que no se puede listar | `not-listed` con el código del sistema; sus entradas anteriores pasan a `unverified` y **no se informan como eliminadas**. |
| Metadatos ilegibles de una entrada | `unverified`; conserva el último registro o queda como `unknown`. |
| Carpeta sustituida o convertida en enlace antes de abrirla | `not-listed`, `ECHANGED`; no se lista. |
| Entrada que desaparece durante el recorrido | Se omite: es una eliminación real. |
| Directorio de otro volumen | `not-listed`, `OTHER_VOLUME`; no se abre. |
| Nombre que no es UTF-8 válido | Incidencia `NAME_NOT_UTF8` en su carpeta; no se inventa una ruta. |
| Raíz inexistente o no listable | `SCOPE_UNAVAILABLE`; índice anterior intacto. |
| Raíz o ancestro convertido en enlace | `SCOPE_CHANGED`; índice anterior intacto. |
| Recorrido seguro no disponible | `SAFE_SCAN_UNAVAILABLE`; no se escribe nada. |
| Más entradas que `maxEntries` (100 000 por defecto) | `INDEX_LIMIT_EXCEEDED`; no se publica nada. |
| Índice dañado o enlazado | `INDEX_CORRUPT`, `RECORD_CORRUPT` o `RECORD_LINK`; no se repara ni se sobrescribe. |
| Otra instancia publicó durante el recorrido | `INDEX_CONFLICT`; se puede repetir la operación. |

Errores nuevos: `INVALID_SCOPE_RESOLVER`, `INVALID_INDEX_LIMIT`, `INVALID_SCOPE_ID`,
`INVALID_SCOPE`, `SCOPE_OVERLAPS_INTERNAL`, `SCOPE_UNAVAILABLE`, `SCOPE_CHANGED`,
`SAFE_SCAN_UNAVAILABLE`, `SAFE_SCAN_FAILED`, `INDEX_LIMIT_EXCEEDED`,
`INDEX_CORRUPT`, `INDEX_INVALID`, `INDEX_CONFLICT`. Los errores del resolutor (por
ejemplo `FOLDER_NOT_AUTHORIZED`) se propagan sin cambios.

## Indexación inicial, reconciliación y eventos

- **Inicial**: primer recorrido completo de un ámbito sin índice previo.
- **Reconciliación**: recorrido completo posterior, ejecutado cuando el Motor lo
  invoca. Detecta lo ocurrido entre dos ejecuciones, no en el momento en que ocurre.
- **Actualización por eventos**: **no implementada.** No hay vigilancia de
  archivos ni servicio residente; los cambios solo se conocen en la siguiente
  reconciliación.

## Pruebas

`npm test` en Windows, Node.js v24.18.0 y Python 3.12.10:

- JavaScript: **56 pruebas, 55 aprobadas, 0 fallos, 1 omitida** — 38 de regresión
  y 18 del indexador. La omitida es la del FIFO, solo POSIX.
- Lectura segura (Incremento 03): **10 aprobadas**.
- Recorrido por referencias: **12 pruebas, 11 aprobadas, 1 omitida** — la de
  identidad por inode, solo POSIX.

Los resultados en macOS y Linux se reflejan en los checks de la PR; no se
anticipan aquí.

Las pruebas nativas usan barreras deterministas dentro del algoritmo para:
renombrar la raíz y dejar un enlace hacia otra carpeta con nombres ajenos;
hacer lo mismo con una carpeta intermedia ya adquirida; sustituir una hija por un
enlace o por otra carpeta antes de abrirla; y eliminarla antes de abrirla. En
todos los casos se comprueba que ningún nombre ajeno llega a los registros.
También verifican que cada apertura nativa pide un directorio sin seguir enlaces,
que solo se abren carpetas, que todas las referencias se cierran (también al
superar el límite), otro volumen, nombres fuera de UTF-8 reales (Windows y Linux)
y el protocolo con el proceso del Motor.

Las pruebas JavaScript cubren: índice inicial con tipos, tamaños y fechas;
originales intactos (bytes y fechas); altas, cambios, bajas, cambio de tipo,
cambio con el mismo tamaño y bajas de subárboles; recuperación y reconciliación en
procesos separados; enlaces de carpeta y de archivo; una carpeta sustituida por
un enlace hacia fuera; denegación real del SO (ACL de Windows o permisos POSIX)
en una subcarpeta y en la raíz sin falsas bajas; registros no comprobables;
ausencia del auxiliar; raíz desaparecida o redirigida; ámbitos no autorizados,
falsificados o solapados con la Base; retirada antes y durante la indexación;
límite; índices corruptos y enlazados; serialización y conflicto; FIFO (POSIX).

Todos los datos son ficticios, en carpetas `.mind-index-test-*` y
`.mind-native-index-test-*` hermanas del Motor, fuera de Git y de cualquier Base
personal, eliminadas al terminar.

## Limitaciones

- La garantía de ámbito es la misma que la de la lectura segura: el proceso, el
  intérprete, la Base y el espacio de montajes son de confianza. No cubre montajes
  bind en el mismo dispositivo ni cambios privilegiados del espacio de nombres.
- En Windows, una subcarpeta sustituida por otra carpeta real dentro del ámbito
  antes de abrirla se lista (sigue dentro del ámbito); su identidad solo se
  compara por inode en POSIX.
- En Linux `createdAt` es `null`: Python 3.12 no expone la fecha de creación.
- El índice describe ubicaciones en el momento del recorrido; no es una
  instantánea atómica frente a cambios concurrentes dentro del ámbito.
- Sin hashes, un cambio que conserve tamaño y fecha de modificación no se detecta.
  La fecha se guarda con precisión de milisegundos.
- Cada reconciliación recorre todo el ámbito y guarda el índice en un único JSON.
  La profundidad está limitada por los descriptores abiertos del proceso: si se
  agotan, la carpeta queda `not-listed` (`EMFILE`).
- En sistemas sin distinción de mayúsculas, renombrar solo mayúsculas aparece como
  baja y alta. macOS puede devolver nombres en NFD; se guardan tal como llegan.
- El incremento original solo serializaba dentro de una instancia. La corrección
  posterior incorpora [coordinación entre procesos](CONCURRENCIA_INDICES.md).
- Retirar una carpeta en el Incremento 02 no elimina hoy su índice: la integración
  deberá llamar a `removeFolderIndex`.

## Qué se necesita para conectarlo al Motor oficial

1. Crear el indexador dentro de `openMotor` con la Base física, el mismo
   `pythonExecutable` del lector y un resolutor basado en `loadAuthorizedFolder`,
   sin aceptar rutas.
2. Decidir quién puede invocar `indexFolder`/`readFolderIndex`: solo el anfitrión
   administrativo, o agentes con un permiso explícito equivalente al de lectura.
3. Encadenar la retirada de carpetas con `removeFolderIndex`.
4. Exponer comandos de CLI y actualizar `README.md` e `INTERFACES.md`.
5. La actualización por eventos queda para un incremento posterior.

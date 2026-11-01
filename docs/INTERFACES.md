# Interfaces mínimas del Motor

## Contrato ejecutable

Los tipos están documentados mediante JSDoc en `src/motor.js`; no requieren un
compilador ni añaden dependencias.

```js
import { openMotor } from 'mind-motor';

// Base existente y absoluta, independiente del directorio del Motor.
const motor = await openMotor({ baseDirectory: rutaAbsoluta });
await motor.writeRecord('prueba', 'texto ficticio');
const record = await motor.readRecord('prueba');
```

| Interfaz | Entrada | Resultado |
|---|---|---|
| `openMotor(options)` | `MotorOptions = { baseDirectory: string }` | `Promise<Motor>` |
| `Motor.baseDirectory` | — | Ruta física de la Base externa |
| `Motor.writeRecord(id, value)` | Identificador válido y texto | `Promise<TechnicalRecord>` |
| `Motor.readRecord(id)` | Identificador válido | `Promise<TechnicalRecord \| null>` |
| `TechnicalRecord` | — | `{ id: string, value: string }` |
| `MotorError` | — | Error con `code` estable y mensaje sin contenido del registro |

Abrir no crea archivos. Cada operación espera a terminar su E/S antes de resolver.
No existe `close()`: el núcleo no mantiene recursos abiertos ni un proceso residente.
Una llamada exitosa a `writeRecord` ha escrito y publicado el registro en la Base;
leer desde otra instancia/proceso no necesita estado en memoria de la anterior.

Errores propios: `INVALID_BASE`, `BASE_NOT_FOUND`, `BASE_OVERLAPS_MOTOR`,
`INVALID_ID`, `INVALID_VALUE`, `RECORD_LINK`, `RECORD_CORRUPT`.
La CLI añade `INVALID_ARGUMENTS`. Los errores de E/S mantienen el código del sistema.

## Registro de carpetas del usuario

| Operación de `Motor` | Entrada | Resultado |
|---|---|---|
| `authorizeFolder(folderPath)` | Ruta absoluta de una carpeta existente y accesible | `Promise<AuthorizedFolder>` |
| `listAuthorizedFolders()` | — | `Promise<AuthorizedFolder[]>` |
| `revokeFolder(id)` | Identificador devuelto al registrar | `Promise<boolean>`: si se retiró un registro |
| `checkFolderScope(id, targetPath)` | Id y ruta absoluta existente | `Promise<{ folderId, path }>` o error |
| `AuthorizedFolder` | — | `{ id: string, path: string }` |

La ruta guardada es la física, obtenida con `realpath`. El id se deriva de ella con
SHA-256; en Windows se normaliza la diferencia entre mayúsculas y minúsculas.
Cada carpeta tiene su propio archivo de autorización versionado en la Base, separado
de los registros técnicos de texto. La retirada elimina únicamente ese archivo.
No se guardan nombres de agentes, permisos por operación ni credenciales.
Los nuevos registros usan formato v2 con `generation` aleatoria: retirar y volver
a registrar la misma ubicación no reactiva permisos anteriores. Se siguen leyendo
registros v1 del Incremento 02, sin migrarlos ni reescribirlos al consultar.

`checkFolderScope` prepara una frontera de alcance para operaciones futuras:
comprueba que la autorización sigue presente, que su raíz existe y no ha sido
redirigida, y que la ruta física solicitada pertenece a esa raíz. Rechaza carpetas
vecinas con el mismo prefijo, rutas ascendentes y enlaces estáticos que salen de la
raíz autorizada. La retirada se vuelve a consultar en cada llamada, sin permisos
en caché. No se abre el contenido del destino ni se recorren las carpetas.

**Esta precomprobación no es una autorización para un agente ni una apertura segura
de archivos.** Las operaciones futuras tendrán que verificar por separado quién
solicita el acceso y qué operación ha permitido el usuario, y resolver los cambios
de rutas entre la comprobación y el uso. El modelo actual confía en el proceso local
y la Base; no aporta aislamiento frente a otros programas del usuario.

Las llamadas simultáneas a carpetas distintas no se pisan. No hay transacciones
entre procesos: registrar y retirar la misma carpeta se debe hacer secuencialmente.
No se detecta la sustitución de una carpeta por otra que conserve exactamente su
ruta física sin enlaces; el registro representa una ubicación, no una identidad de
inode ni una concesión de acceso irrevocable.

Errores adicionales: `INVALID_FOLDER_PATH`, `NOT_A_FOLDER`, `FOLDER_UNAVAILABLE`,
`FOLDER_OVERLAPS_INTERNAL`, `INVALID_AUTHORIZATION_ID`, `AUTHORIZATION_CORRUPT`,
`FOLDER_NOT_AUTHORIZED`, `FOLDER_CHANGED`, `PATH_UNAVAILABLE`, `PATH_OUTSIDE_SCOPE`.
Los archivos de metadatos enlazados o con JSON inválido conservan los errores
`RECORD_LINK` y `RECORD_CORRUPT`. Los registros corruptos fallan explícitamente; no
se convierten silenciosamente en permisos ni se reparan al consultar.

## Incorporación posterior de las cinco capacidades

La frontera común es una operación asíncrona que recibe una instancia `Motor`
y la petición propia de su capacidad, y devuelve un resultado. Esta frontera no
requiere registro de plugins, servidor, objetos de dominio ni cinco métodos vacíos.
Los futuros módulos podrán utilizar el contexto explícito del Motor; no deben
suponer una Base global o escribir datos técnicos dentro del código.

| Capacidad conceptual | Entrada de su futura interfaz | Resultado esperado |
|---|---|---|
| Indexar | Rutas autorizadas y alcance de la operación | Registros de índice en la Base |
| Encontrar y acceder | Criterio de búsqueda y alcance autorizado | Localizadores o información solicitada |
| Crear, modificar y organizar | Operación y destinos autorizados | Resultado de la operación y actualización de registros |
| Gestionar funciones | Definición o invocación de una función | Registro o resultado de ejecución |
| Dar continuidad | Información de un trabajo o petición de recuperación | Contexto recuperable o exportable |

Estas filas fijan límites de integración, no implementan ni congelan los contratos
particulares. El Incremento 02 incorpora el registro administrativo de carpetas.
El Incremento 03 incorpora permisos efímeros y lectura puntual de originales.
Integración de agentes externos, índices, planificación y formato de continuidad
requieren incrementos aprobados por separado. El almacenamiento de
texto de este núcleo no pretende resolver por adelantado sus necesidades.

## Lectura puntual y autorización — Incremento 03

`openMotor({ baseDirectory, pythonExecutable? })` permite al anfitrión elegir un
intérprete de confianza. El valor predeterminado es `python` en Windows y `python3`
en macOS/Linux. No se usa shell; se invoca el auxiliar propio con `-I -B` (modo
aislado y sin bytecode). Una invocación por intento, timeout de 10 segundos.

| Operación | Entrada | Resultado |
|---|---|---|
| `grantTextRead` | `{ requester: object, folderId, relativePath }` | Permiso opaco efímero, solo para ese solicitante y archivo |
| `revokeTextRead` | Objeto permiso original | `boolean`, retirada antes de comenzar el intento |
| `readTextFile` | `{ requester: object, authorization: object }` | `Promise<{ folderId, relativePath, content }>` |

La concesión es administrativa: el anfitrión de confianza la ejecuta tras la
autorización explícita del usuario. No se admite un nombre de agente como prueba
de identidad: `requester` se compara por identidad de objeto, y el permiso es una
clave de un `WeakMap` privado. Copiarlo, serializarlo, conocer la ruta/id, usarlo
desde otra instancia o presentar otro objeto con el mismo nombre no concede acceso.
El anfitrión entrega al agente únicamente una función ligada a su identidad y su
permiso, sin la API administrativa. Esta es una frontera de capacidades dentro de
un proceso confiable; no autentica agentes remotos ni aísla código hostil en el
proceso. No implementa una interfaz de consentimiento ni un transporte externo.

`relativePath` utiliza `/` en los tres sistemas. Rechaza componentes vacíos, `.` y
`..`, rutas absolutas, barras inversas, NUL/controles, ADS, nombres reservados y
alias Win32 con punto/espacio final. El permiso fija la ruta; la lectura no acepta
una ruta alternativa. Es de un solo intento y se consume antes de E/S: un fallo
también exige una nueva autorización. No persiste entre procesos.

Se consulta el registro antes de abrir y otra vez después de obtener el descriptor,
antes de leer. Si se retiró o cambió su generación, no se lee el contenido. La
retirada durante una lectura ya iniciada no cancela ni recupera bytes entregados;
no hay transacciones entre procesos. `revokeTextRead` devuelve `false` si el intento
ya comenzó. El registro sigue autorizando una ubicación, no un inode histórico:
reemplazar un archivo o una carpeta ordinaria antes de abrir puede seleccionar su
reemplazo en esa ubicación. Una vez abierto, se conserva el objeto adquirido.

Solo archivos regulares, UTF-8 estricto sin NUL, máximo 1 MiB, BOM preservado. No
se presupone texto por extensión. Los errores descartan todos los bytes acumulados.
Los permisos del SO siguen aplicándose; no se solicitan derechos de escritura.

Errores nuevos: `INVALID_REQUESTER`, `INVALID_READ_PATH`, `READ_NOT_AUTHORIZED`,
`ACCESS_DENIED`, `FILE_NOT_FOUND`, `UNSAFE_PATH`, `FILE_TOO_LARGE`, `TEXT_UNREADABLE`,
`READ_FAILED`, `SAFE_OPEN_UNAVAILABLE`. Se conservan los errores del registro de
carpetas y metadatos. Ningún mensaje contiene el contenido parcial del original.

El algoritmo, su evidencia y sus límites están en [INCREMENTO_03.md](INCREMENTO_03.md).

## Indexación administrativa integrada

| Operación de Motor | Entrada | Resultado |
|---|---|---|
| `indexFolder(folderId)` | Id del registro existente; ninguna ruta ni resolutor externo | `Promise<IndexResult>`: índice inicial o reconciliación |
| `readFolderIndex(folderId)` | Id registrado | `Promise<FolderIndex | null>`: último índice vigente o null |
| `revokeFolder(folderId)` | Id del registro | Retira autorización y elimina índice; conserva el booleano previo |
| `searchFiles(request)` | `SearchRequest`: ids que el anfitrión autoriza para la consulta, texto y filtros | `Promise<{ results, total, offset, limit, truncated, scopes }>` |
| `openIndexObserver(options?)` | `{ onReport?, strategy?, debounceMs?, … }` | Observador de la sesión: `observe`, `reconcile`, `status`, `list`, `unobserve`, `close` |

`searchFiles` (Incremento 09) consulta solo los índices vigentes de la Base, sin
recorrer las carpetas ni abrir archivos. Cada resultado es `{ folderId,
relativePath, name, type, size, modifiedAt, changedAt, createdAt, status, reason,
indexedAt }`; `folderId` y `relativePath` tienen la forma que espera
`grantTextRead`, pero la búsqueda no concede la lectura. `status` es `indexed`
(confirmado por el recorrido de `indexedAt` o, si lo creó el Motor después, al
crearlo; véase la sección de creación) o `unverified`. Detalle en
[INCREMENTO_09.md](INCREMENTO_09.md).

Son operaciones del anfitrión administrativo, como registrar y retirar carpetas.
No se exponen al agente por poseer un permiso de lectura puntual. El Motor inyecta
su `loadAuthorizedFolder`, la Base física y `pythonExecutable`; no se crea un
registro de permisos adicional. Continuidad y definiciones de funciones conservan
sus interfaces internas y no se agregan al objeto Motor ni a la CLI.

El índice v2 añade `authorizationGeneration`, distinto del contador numérico
`generation` del índice. Debe coincidir con la generación de la autorización y
la raíz registrada. Un registro de carpeta heredado v1 se representa con null;
una concesión posterior ya usa la generación aleatoria v2. Los índices v1 no
ligados a autorización se validan como formato histórico, pero se devuelven como
null y no se usan para reconciliar. Un índice de otra concesión tampoco aporta
entradas anteriores ni cambios: se reconstruye como inicial.

Se revalida identidad de la autorización antes y después de consultar/recorrer.
Un cambio durante la operación produce `INDEX_SCOPE_CHANGED`; una retirada
produce `FOLDER_NOT_AUTHORIZED`. Permanecen los errores del indexador y del
almacenamiento: corrupción o enlaces no se reparan silenciosamente.

La retirada revoca antes de limpiar; si limpiar falla, el error se informa y la
carpeta sigue retirada. Una publicación tardía puede dejar físicamente un índice
viejo, pero el vínculo de generación impide ofrecerlo con una nueva autorización.
No hay transacciones ni bloqueo entre procesos; se conserva el modelo local de
confianza. Solo se descartan índices, nunca originales.

## Creación de un archivo de texto nuevo — Función 03 integrada

| Operación de Motor | Entrada | Resultado |
|---|---|---|
| `grantTextCreate` | `{ requester: object, folderId, relativePath }` | Permiso opaco de un solo intento. Solo anfitrión. |
| `revokeTextCreate` | Objeto permiso original | `boolean`: retirado antes de comenzar el intento. Solo anfitrión. |
| `createTextFile` | `{ requester: object, authorization: object, content: string }` | `Promise<{ folderId, relativePath, size, indexEntry, index }>` |

El núcleo es `src/text-creator.js` + `src/native_writer.py`
([FUNCION_03_CREAR.md](FUNCION_03_CREAR.md)). `openMotor` lo crea con el mismo
`loadAuthorizedFolder` del registro y el mismo `pythonExecutable` que el lector:
no hay otro registro de permisos. El permiso se liga por identidad de objeto al
`requester`, a la carpeta (id + generación), a la ruta exacta y a la operación;
los permisos de lectura y de creación viven en mapas distintos y no se
intercambian. Se consume antes de cualquier E/S, no persiste entre procesos ni
sirve en otra instancia de Motor. Retirar o reautorizar la carpeta invalida los
permisos pendientes. El anfitrión entrega al agente solo una función ligada a su
identidad que llama a `createTextFile`.

Solo crea un archivo nuevo, UTF-8 sin NUL y de hasta 1 MiB, en una carpeta que ya
existe. Nunca reemplaza: un nombre existente da `FILE_EXISTS`. No crea carpetas
intermedias, ni modifica, mueve o elimina archivos.

### Coherencia del índice

Tras crear, el Motor intenta incorporar `indexEntry` (metadatos leídos del
archivo creado) al índice vigente de la carpeta, en la misma cola por ámbito que
`indexFolder`. `index.status` informa el resultado:

| `status` | Significado |
|---|---|
| `updated` | Entrada incorporada; `generation` del índice aumenta en 1. |
| `current` | El índice ya tenía exactamente esa entrada. |
| `not-indexed` | La carpeta no tiene índice vigente; no se crea uno. |
| `needs-reconciliation` | No se publicó nada; `code` explica el motivo. |

Motivos de `needs-reconciliation`: `INDEX_ENTRY_CONFLICT` (el índice tenía otra
entrada con ese nombre), `INDEX_PARENT_NOT_CURRENT` (alguna carpeta padre falta o
no está listada y verificada), `INDEX_LIMIT_EXCEEDED`, `INDEX_CONFLICT` (otro
proceso publicó a la vez) o el error de lectura del índice (p. ej.
`RECORD_CORRUPT`). La reconciliación explícita es `indexFolder(folderId)`. Un fallo
del índice nunca convierte en error una creación ya realizada.

`updatedAt` del índice (el `indexedAt` de `searchFiles`) sigue siendo la fecha del
último recorrido completo. Una entrada incorporada por creación lleva sus propias
fechas, posteriores, leídas del archivo creado; las demás entradas, incluida la
fecha de su carpeta padre, siguen siendo las de ese recorrido.

Errores: los de [FUNCION_03_CREAR.md](FUNCION_03_CREAR.md) (`CREATE_NOT_AUTHORIZED`,
`FILE_EXISTS`, `PARENT_NOT_FOUND`, `UNSAFE_PATH`, `CREATE_UNCONFIRMED`, …). Si el
resultado es `CREATE_FAILED` por tiempo o `CREATE_UNCONFIRMED`, el archivo puede
existir sin entrada en el índice: corresponde reconciliar.

## Modificación de un archivo de texto existente — Función 03 integrada

| Operación de Motor | Entrada | Resultado |
|---|---|---|
| `grantTextModify` | `{ requester: object, folderId, relativePath }` | Permiso opaco de un solo intento. Solo anfitrión. |
| `revokeTextModify` | Objeto permiso original | `boolean`: retirado antes de comenzar el intento. Solo anfitrión. |
| `modifyTextFile` | `{ requester, authorization, expectedVersion, content }` | `Promise<{ folderId, relativePath, size, previousVersion, version, indexEntry, index }>` |
| `textVersion(content)` (exportada) | Texto | `"sha256:<64 hex>"` de sus bytes UTF-8 |

El núcleo es `src/text-modifier.js` + `src/native_modifier.py`
([FUNCION_03_MODIFICAR.md](FUNCION_03_MODIFICAR.md)). `openMotor` lo crea con el
mismo `loadAuthorizedFolder` y `pythonExecutable` que la lectura y la creación.
Los permisos de modificación viven en su propio mapa: no sirven para leer ni crear,
ni al revés. Se ligan por identidad de objeto al `requester`, a la carpeta (id +
generación) y a la ruta exacta. Se consumen antes de validar o abrir, no persisten
entre procesos ni sirven en otra instancia. Retirar o reautorizar la carpeta los
invalida.

### Versión y `VERSION_CONFLICT`

`expectedVersion` es `textVersion(content)` del texto que el agente leyó con
`readTextFile`. Coincide con el archivo porque la lectura devuelve UTF-8 estricto
con el BOM preservado. El auxiliar vuelve a leer el archivo por el mismo handle
que va a sustituir y compara el SHA-256. Si difiere, falla con
`VERSION_CONFLICT` y no escribe nada en el archivo ni en el índice: el agente
debe releer, rehacer su cambio y pedir un permiso nuevo. Antes de publicar se
comprueba de nuevo que el nombre sigue designando ese mismo archivo. Si fue
sustituido, borrado o cambiado entretanto, también da `VERSION_CONFLICT`.
`version` del resultado es la versión publicada.

### Límites de concurrencia

- Windows: mientras dura la operación el archivo se mantiene abierto sin compartir
  escritura, así que nadie puede cambiar su contenido. Si otro programa ya lo tenía
  abierto para escribir, falla con `FILE_IN_USE`. Sí se permite renombrarlo o
  borrarlo, lo que se detecta salvo en la ventana final.
- POSIX: no hay bloqueos obligatorios. Un cambio ajeno anterior a la última
  comprobación (inode, tamaño, mtime y ctime) se detecta.
- En ambos queda una ventana de microsegundos entre esa última comprobación y el
  rename atómico en la que un cambio ajeno simultáneo podría perderse. Si eso deja
  un resultado que no se puede confirmar, la operación devuelve `MODIFY_UNCONFIRMED`.
- Dos agentes con la misma versión: se publica uno y el otro recibe
  `VERSION_CONFLICT` (o `FILE_IN_USE` en Windows si coinciden en la apertura).
- No hay transacciones ni bloqueo entre procesos para el índice. Una publicación
  concurrente del índice da `INDEX_CONFLICT` y pide reconciliación.

### Coherencia del índice

Tras publicar, el Motor llama a `recordModifiedFile` del indexador, en la misma
cola por ámbito que `indexFolder` y `recordCreatedFile`. La entrada solo se
sustituye si el índice vigente ya tenía ese nombre como archivo. `index.status`
tiene los mismos valores que en la creación:

| `status` | Significado |
|---|---|
| `updated` | Entrada sustituida; `generation` del índice aumenta en 1. |
| `current` | El índice ya tenía exactamente esa entrada. |
| `not-indexed` | La carpeta no tiene índice vigente; no se crea uno. |
| `needs-reconciliation` | No se publicó nada; `code` explica el motivo. |

Motivos de `needs-reconciliation`:
- `INDEX_ENTRY_MISSING`: el índice no conocía el archivo.
- `INDEX_ENTRY_CONFLICT`: el índice tenía ese nombre como otro tipo.
- `INDEX_CONFLICT`: otro proceso publicó el índice a la vez.
- El error de lectura del índice, por ejemplo `RECORD_CORRUPT`.

La reconciliación explícita es `indexFolder(folderId)`. Un fallo del índice nunca
convierte en error una modificación ya publicada. `updatedAt` del índice sigue
siendo la fecha del último recorrido completo; la entrada sustituida lleva sus
propias fechas, leídas del archivo publicado.

Errores: los de [FUNCION_03_MODIFICAR.md](FUNCION_03_MODIFICAR.md)
(`MODIFY_NOT_AUTHORIZED`, `INVALID_VERSION`, `VERSION_CONFLICT`, `FILE_IN_USE`,
`METADATA_NOT_PRESERVABLE`, `MODIFY_UNCONFIRMED`, …). Si el resultado es
`MODIFY_FAILED` por tiempo o `MODIFY_UNCONFIRMED`, el contenido nuevo puede estar
publicado sin entrada actualizada: corresponde releer y reconciliar.

## Observación de cambios — Función 01 integrada

`openIndexObserver(options)` es una capacidad **opcional** de la sesión del
anfitrión. `openMotor` no abre observaciones: solo existen después de llamarla.
Devuelve el observador de [FUNCION_01_OBSERVACION.md](FUNCION_01_OBSERVACION.md)
ligado a este Motor; la opción `motor` se ignora, de modo que siempre actúa con
el `indexFolder`, `readFolderIndex` y `listAuthorizedFolders` de esta instancia y
con su Base. No se entrega a agentes ni concede lectura o búsqueda.

| Operación del observador | Resultado |
|---|---|
| `observe(folderId)` | Reconciliación inicial y observación; resuelve con el estado. |
| `reconcile(folderId)` | Reconciliación inmediata pedida por el anfitrión. |
| `status(folderId)` / `list()` | Estado de cada carpeta observada; `null` si no se observa. |
| `unobserve(folderId)` | Deja de observar; el índice se conserva. |
| `close()` | Detiene todo y libera observaciones y temporizadores. |

Los avisos del sistema solo deciden cuándo reconciliar; cada actualización es una
llamada a `indexFolder`, con el recorrido seguro y la vigencia de la autorización
de siempre. Las búsquedas reflejan el cambio cuando termina esa reconciliación
(agrupación por defecto: 300 ms de silencio, máximo 5 s, al menos 2 s entre
recorridos), no en el instante del cambio.

Sin servicio residente: las observaciones no son persistentes y los temporizadores
no mantienen vivo el proceso. Si el proceso termina, la observación termina con
él; el siguiente `observe` reconcilia lo ocurrido entretanto.

Retirada: `revokeFolder(folderId)` en este Motor pide una reconciliación a sus
observadores abiertos, que falla con `FOLDER_NOT_AUTHORIZED` y detiene esa
carpeta (`stopped`, motivo `revoked`) antes de que `revokeFolder` resuelva; esto
ocurre aunque falle la limpieza del índice. Una retirada desde otra instancia o
proceso se detecta por la observación de la Base o por la comprobación periódica
(`authorizationCheckMs`, 5 s). Una nueva autorización de la misma ruta no hereda
la observación. Cerrar el observador no retira autorizaciones ni índices.


# Interfaces mínimas — Incrementos 01 y 02

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
Permisos de agentes, acceso a originales, índices, planificación y formato de
continuidad requieren incrementos aprobados por separado. El almacenamiento de
texto de este núcleo no pretende resolver por adelantado sus necesidades.

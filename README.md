# Mind 1.0 — Motor

Núcleo local construido desde cero. Utiliza JavaScript con módulos ESM y Node.js
24 LTS. La lectura segura de originales requiere además Python 3.12 o posterior;
usa su biblioteca estándar, sin paquetes adicionales ni compilación.

## Ejecutar

Desde `Mind - Desarrollo/Motor`, en PowerShell:

```powershell
$base = (Resolve-Path -LiteralPath '../Base').Path
node src/cli.js --base $base status
node src/cli.js --base $base write prueba 'Registro ficticio persistente'
node src/cli.js --base $base read prueba
```

Cada comando arranca un proceso, realiza una operación y termina. El tercer comando
recupera el registro escrito por el proceso anterior. Se puede cerrar la terminal y
volver a ejecutar la lectura usando la misma ruta de Base.

En macOS/Linux:

```sh
base="$(cd ../Base && pwd -P)"
node src/cli.js --base "$base" status
node src/cli.js --base "$base" write prueba 'Registro ficticio persistente'
node src/cli.js --base "$base" read prueba
```

La Base debe existir y su ruta debe ser absoluta. No hay una Base predeterminada.
Los comandos devuelven JSON; los errores van a stderr y terminan con código 1.
Leer un registro inexistente devuelve `null` y código 0.

## Motor y Base independientes

- `Motor/`: código, pruebas, documentación y raíz Git.
- `../Base/`: registros técnicos persistentes, fuera del repositorio.
- Temporales de escritura: dentro de la Base; temporales de pruebas: en directorios
  `.mind-test-*` junto al Motor, eliminados al finalizar cada prueba.
- La Base no puede ser el Motor, estar dentro de él ni contenerlo; se comprueban las
  rutas físicas, incluso si la ruta proporcionada utiliza enlaces de directorio.
- `My Mind/` permanece reservado para la primera versión estable.

Un registro contiene un identificador y texto UTF-8. Se guarda como
`record-<id>.json` dentro de la Base, con un formato técnico versionado. Escribir
el mismo identificador reemplaza su valor; no crea historial ni transacciones.
El identificador admite de 1 a 64 caracteres: minúsculas ASCII, números, guion y
guion bajo, comenzando con letra o número.

La escritura prepara un archivo temporal exclusivo, sincroniza su contenido y lo
renombra al destino dentro de la misma Base. No se mantienen archivos abiertos
entre operaciones. La persistencia después de terminar y volver a iniciar el
proceso se verifica automáticamente. No se garantiza recuperación ante cortes de
energía, cambios hostiles de rutas mientras se opera ni coordinación de escrituras
concurrentes sobre el mismo registro. La Base de este incremento es local y de
confianza, con datos ficticios. Los temporales de un proceso interrumpido pueden
quedar en la Base; nunca se interpretan como registros.

## Carpetas autorizadas — Incremento 02

El usuario puede registrar una carpeta existente, consultar las registradas y retirar
una autorización. En PowerShell, usando la variable `$base` del ejemplo anterior y
una carpeta de información de pruebas ya existente:

```powershell
$carpeta = (Resolve-Path -LiteralPath '../Información de prueba').Path
node src/cli.js --base $base folder-add $carpeta
node src/cli.js --base $base folder-list
# Copiar el id devuelto; no es la ruta de la carpeta.
node src/cli.js --base $base folder-remove '<id>'
```

Los mismos comandos funcionan en macOS/Linux con `--base "$base"` y rutas absolutas
entre comillas. Cada invocación termina; el registro y la retirada sobreviven a un
nuevo proceso del Motor. `folder-remove` devuelve `{"removed":false}` si el id ya
no estaba registrado.

Se guardan un identificador, la ruta física y una generación de autorización en un archivo
`folder-authorization-<id>.json` de la Base. Los alias de directorio se resuelven al
registrar y no crean otra autorización para la misma ruta física. Las carpetas deben
ser accesibles y no pueden solaparse con Motor o Base, ni contenerlos. Consultar
muestra los registros guardados, aunque una carpeta haya desaparecido; retirarla
por id no requiere que siga existiendo.

**Registrar es una operación administrativa local del usuario. No concede acceso a
ningún agente.** El registro no lee originales ni indexa. Para validar una carpeta
solo se consultan sus metadatos y se abre y
cierra el directorio, sin enumerar entradas. Los detalles están en
[docs/INTERFACES.md](docs/INTERFACES.md).

## Primera lectura segura — Incremento 03

La API permite solicitar un texto UTF-8 de hasta 1 MiB. El anfitrión local, después
de una autorización explícita del usuario, concede un permiso opaco de un solo
intento para una identidad y un archivo relativo exactos. Registrar la carpeta o
conocer su id no permite leerla. No hay un comando CLI que fabrique el permiso
usando un nombre de agente. Ejemplo del anfitrión, con datos ficticios:

```js
const requester = Object.freeze({ name: 'Agente de prueba' });
// Solo el anfitrión conserva motor y puede conceder permisos.
const authorization = await motor.grantTextRead({
  requester, folderId: carpetaRegistrada.id, relativePath: 'notas/ejemplo.txt',
});
// Esta función ligada a la identidad es la que se entrega al agente.
const readForAgent = (permission) => motor.readTextFile({ requester, authorization: permission });
const result = await readForAgent(authorization);
console.log(result.content);
```

El auxiliar abre cada componente relativo a un directorio ya abierto, sin seguir
enlaces, y lee por el descriptor final. En POSIX usa `openat` mediante `os.open`
con `dir_fd` y `O_NOFOLLOW`; en Windows usa `NtCreateFile` con `RootDirectory` y
`FILE_OPEN_REPARSE_POINT`, verificando los atributos del handle. No usa la
precomprobación `checkFolderScope` como garantía de apertura. Rechaza también los
enlaces internos y archivos con varios enlaces duros; no enumera originales.

Se distinguen permiso ausente, acceso denegado por el SO, archivo desaparecido,
ruta insegura, fallo de lectura, tamaño excesivo y texto inválido. Nunca se entrega
un resultado parcial. No se escribe el contenido en la Base ni se modifica el
original; el SO puede actualizar su fecha de último acceso.

**Límites:** anfitrión, código, intérprete, Base y espacio de montajes de confianza;
no hay aislamiento frente a código que ya ejecute dentro de ese proceso o con los
permisos del usuario. Windows admite volúmenes locales fijos con letra y rechaza
UNC/dispositivos/rutas extendidas. No se garantiza una instantánea frente a
escrituras concurrentes, ni procedencia histórica del archivo, ni protección ante
cambios privilegiados de montajes. Si falta una primitiva segura, se deniega sin
recurrir a una apertura más débil. Véase [docs/INCREMENTO_03.md](docs/INCREMENTO_03.md).

## Creación segura de un archivo de texto — Función 03

El anfitrión concede, tras la autorización explícita del usuario, un permiso de un
solo intento para crear un archivo concreto. El agente recibe solo una función
ligada a su identidad:

```js
const authorization = await motor.grantTextCreate({ requester, folderId, relativePath: 'notas/nueva.txt' });
const created = await motor.createTextFile({ requester, authorization, content: 'Texto ficticio\n' });
// { folderId, relativePath, size, indexEntry, index: { status, generation, code } }
```

Usa el mismo registro de carpetas y el mismo modelo de permisos que la lectura;
un permiso de lectura no sirve para crear ni al revés. Solo crea archivos nuevos
de texto UTF-8 de hasta 1 MiB en carpetas existentes; nunca reemplaza
(`FILE_EXISTS`) ni crea carpetas. Tras crear, el Motor incorpora el archivo al
índice vigente cuando es seguro (`index.status: 'updated'`), de modo que
`searchFiles` lo encuentra sin recorrer la carpeta. Si el índice no conoce las
carpetas padre, tenía otra entrada con ese nombre o no se pudo actualizar, no se
publica nada y `index.status` es `needs-reconciliation`: se reconcilia con
`motor.indexFolder(folderId)`. Detalles en
[docs/FUNCION_03_CREAR.md](docs/FUNCION_03_CREAR.md) y
[docs/INTERFACES.md](docs/INTERFACES.md).

## Modificación segura de un archivo de texto — Función 03

El agente lee el archivo, calcula su versión y entrega el contenido nuevo completo.
El anfitrión concede antes un permiso de un solo intento para ese archivo exacto:

```js
import { textVersion } from 'mind-motor';

const authorization = await motor.grantTextModify({ requester, folderId, relativePath: 'notas/a.txt' });
const modified = await motor.modifyTextFile({
  requester, authorization, expectedVersion: textVersion(leido.content), content: nuevoTexto,
});
// { folderId, relativePath, size, previousVersion, version, indexEntry, index }
```

Si el archivo cambió desde esa lectura, la operación falla con `VERSION_CONFLICT`
y no escribe nada: hay que releer y volver a pedir permiso. El contenido se escribe
completo en un temporal y se publica con un rename atómico; nunca se trunca el
original. Se rechazan enlaces, archivos protegidos o con metadatos que no se
pueden conservar. Tras publicar, el Motor sustituye la entrada del índice cuando
es seguro (`index.status: 'updated'`); si no, `needs-reconciliation`. Los
modificadores de Mind se excluyen mediante flock en macOS/Linux y derechos de
apertura sin compartir escritura en Windows. Un competidor obtiene FILE_IN_USE
o VERSION_CONFLICT. En POSIX el bloqueo es consultivo: programas externos que
no lo respeten todavía pueden interferir. Solo texto UTF-8 de hasta 1 MiB; no hay
movimiento ni eliminación. Detalles en
[docs/FUNCION_03_MODIFICAR.md](docs/FUNCION_03_MODIFICAR.md) y
[docs/INTERFACES.md](docs/INTERFACES.md).

## Uso selectivo

Mind es opcional. Los agentes pueden usarlo cuando aporte valor y acudir
directamente a otras herramientas cuando sea suficiente, respetando siempre las
autorizaciones aplicables. Esta decisión se recoge en las instrucciones de uso;
no añade un gestor ni un paso obligatorio a todas las tareas.

## Módulos integrados

El anfitrión administrativo puede crear/reconciliar y consultar el índice de
metadatos mediante `motor.indexFolder(folderId)` y
`motor.readFolderIndex(folderId)`. El id debe existir en el registro de carpetas;
no se aceptan rutas como ámbitos. El recorrido usa el mismo intérprete configurado
para el lector seguro y no abre el contenido de los archivos.

Las mutaciones de un mismo índice se coordinan entre procesos mediante un
bloqueo exclusivo en la Base. Las carpetas distintas conservan su paralelismo.
`revokeFolder` adquiere esa misma coordinación, retira la autorización y elimina
el índice. Los índices se ligan además a la generación del registro: retirar y
reautorizar la misma ubicación no recupera información de una concesión anterior.
Los índices antiguos sin ese vínculo se consideran no vigentes y se reconstruyen
al indexar. Política de espera, recuperación y límites en
[docs/CONCURRENCIA_INDICES.md](docs/CONCURRENCIA_INDICES.md).

`motor.searchFiles({ folderIds, query, ... })` busca archivos por nombre, con
coincidencias parciales y filtros de metadatos, en los índices vigentes de las
carpetas indicadas por el anfitrión. No vuelve a recorrer las carpetas ni abre
contenido. Detalles en [docs/INCREMENTO_09.md](docs/INCREMENTO_09.md).

La indexación, la consulta del índice y la búsqueda son administrativas; registrar una carpeta
no concede estas operaciones a un agente. No se añaden comandos CLI ni permisos
paralelos. Continuidad y definiciones de funciones están integradas en el código
como módulos internos, sin métodos públicos en Motor ni ejecución de funciones.
Detalles en [docs/INTEGRACION_MODULOS.md](docs/INTEGRACION_MODULOS.md).

## Pruebas

```sh
npm test
```

No requiere `npm install`; sí Node.js 24 y Python 3.12+. Se puede ejecutar solo la
parte JavaScript con `node --test test/*.test.js`. La suite completa cubre arranque,
lectura/escritura, reinicio entre procesos, independencia de Bases y código,
validación de rutas y entradas, datos corruptos y limpieza ante fallos. Incluye
registro/retirada persistentes de carpetas, rutas fuera de alcance, enlaces que
escapan del ámbito y rechazo de acceso simulado como denegado.
Añade permisos de un solo intento, denegación real por ACL/modos, texto inválido,
límites y carreras deterministas con referencias del SO. GitHub Actions ejecuta
la misma suite en Windows, macOS y Linux con Node.js 24 y Python 3.12.

## Interfaces y alcance

La API programática y los límites para extender el núcleo están documentados en
[docs/INTERFACES.md](docs/INTERFACES.md). Hay lectura, creación y modificación de
texto con permiso explícito, indexación y búsqueda administrativas, y núcleos
internos de continuidad y definiciones de funciones. Todavía no hay integración de
agentes, ejecución de funciones, automatizaciones, servidores ni interfaz gráfica. Los registros
actuales son datos técnicos de prueba, no una estructura obligatoria para organizar
la información del usuario.

## Colaboración

La rama principal es `main`. Cada incremento se trabaja en una rama y se presenta
mediante un pull request, con alcance, validación y limitaciones explícitas.
No incorporar datos personales, credenciales ni contenido de las Bases.

## Referencia oficial

[docs/Concepto_Mind.pdf](docs/Concepto_Mind.pdf) conserva la referencia conceptual
aprobada. SHA-256:
`a6fcf4dd221bc0b5d0bd1c8430ecfa545c1f7dceb30baa20c93bbd3293963815`.
El PDF describe el producto; no constituye autorización para ejecutar acciones.

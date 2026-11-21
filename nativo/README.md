# Mind nativo — cimientos de Mind 1.0.5

Código de la pieza nativa que, por etapas, asumirá el Motor completo de Mind:
un solo proceso `Mind`, sin Node, Python ni ONNX, para Windows, macOS y Linux
en x64 y ARM64. Mientras dura la transición, el Motor de `src/` (r3) sigue
siendo el único escritor de la Base.

Modos del ejecutable Rust:

- `bridge`: puente MCP stdio ↔ Streamable HTTP hacia el Motor Central.
- `scan`: enumeración segura de un directorio por petición JSONL.
- `anfitrion`: entrada HTTP privada al Motor Central y alojamiento local opcional de vistas.
- `vista`: abre, consulta, reemplaza o cierra una vista estática.
- `servicio`: abre, consulta o cierra una aplicación local con su archivo SQLite.

## Contenido

| Ruta | Qué es |
|---|---|
| `rust/` | Fuente vigente (Rust). `build.ps1` compila en Windows. |
| `go/` | Alternativa Go del piloto. Se conserva porque r3 distribuye binarios Go en cuatro destinos (`packaging/nativo.json`); no es la ruta de 1.0.5. |
| `contracts/r3/` | Contrato observable de r3, capturado del Motor real: `capturar.mjs` y `contrato-r3.json`. |
| `contracts/*.json`, `*.sql`, `CONTRATOS.md` | Borradores de contratos del piloto (scan, rpc, health, esquema v3). Referencia; el vigente es `contracts/r3/`. |
| `test/` | Pruebas del ejecutable contra el Motor de `src/` y prueba del contrato r3. |
| `evidence/` | Mediciones registradas. |
| `RESULTADOS.md` | Resultados del piloto (Rust frente a Go). |

## Compilar

Windows, con `cargo` en el PATH o con la toolchain portátil del piloto:

```powershell
.\nativo\rust\build.ps1
.\nativo\rust\build.ps1 -Toolchain 'D:\ruta\a\toolchain\rust'
```

Salida: `nativo/rust/target/release/mind-native-rust-pilot.exe`.
Los seis destinos se compilan en CI (`.github/workflows/nativo.yml`), cada uno
con el SDK de su sistema.

## Probar

```powershell
node --test --test-concurrency=1 nativo/test/contrato-r3.test.mjs
$env:MIND_NATIVE_EXE = (Resolve-Path .\nativo\rust\target\release\mind-native-rust-pilot.exe).Path
npm test
```

`npm test` incluye siempre el contrato r3, y las pruebas del ejecutable cuando
`MIND_NATIVE_EXE` está definido. Las Bases ficticias se crean en
`%TEMP%\mind-nativo-runs` (o `MIND_NATIVO_RUNS`), fuera del Motor: r3 rechaza
una Base dentro de su programa. Nunca usar una Base personal.

Si el contrato falla, el Motor cambió algo que la pieza nativa debe respetar.
Si el cambio es intencionado: `node nativo/contracts/r3/capturar.mjs --escribir`.

## Vista compartida (Etapa 3)

Con el Motor de una Base ficticia encendido, inicia el candidato con
`anfitrion --base ABS --puerto-vistas 0`. El valor `0` deja que el sistema
elija un puerto libre para la vista. Mind usa el mismo proceso para la página
y la conexión privada, en dos puertos locales.

```text
vista abrir --base ABS --proyecto NOMBRE --copia ABS --contenido ABS
vista consultar --base ABS --id UUID
vista cerrar --base ABS --id UUID
```

`--contenido` apunta a la salida estática con `index.html` y rutas relativas.
En Git, `--copia` es la raíz de la copia de trabajo. La respuesta incluye
el proyecto, la copia, la rama, el commit y los cambios locales. La huella
identifica los archivos servidos y también se calcula para carpetas sin Git.

Guarda la URL como referencia junto con la identidad de la vista en la
conversación. Otro chat recupera esos datos con `retomar` y abre la misma
dirección. Para reemplazar el contenido de la vista, pasa `--id UUID --version N`
a `vista abrir`. La URL conserva la última versión válida y `vista consultar`
permite comprobar su versión actual. `vista cerrar` retira la página y libera
su contenido en memoria. Las vistas duran lo que dura el anfitrión.

La prueba local usa el binario Rust y dos sesiones de Mind con datos ficticios.

```powershell
$env:MIND_NATIVE_EXE = (Resolve-Path '.\nativo\rust\target\release\mind-native-rust-pilot.exe').Path
node --test nativo/test/vista-compartida.test.mjs
```

## Compilación de vistas (Etapa 4)

Con una Base ficticia y el anfitrión de vistas en marcha, guarda una receta
JSON dentro de la copia del proyecto. Indica el programa con ruta absoluta,
sus argumentos y, opcionalmente, el plazo en milisegundos.

```json
{"programa":"C:\\ruta\\node.exe","argumentos":["build.mjs"],"plazo_ms":30000}
```

El programa arranca en la copia con los permisos de la cuenta local. Debe
guardar `index.html` y sus archivos de vista en la carpeta temporal que indica
`MIND_SALIDA`. Revisa la receta y usa el valor `autorizacion` de la respuesta
para ejecutar esa receta desde una consola local de confianza.

```text
vista receta --proyecto NOMBRE --copia ABS --receta ABS
vista construir --base ABS --proyecto NOMBRE --copia ABS --receta ABS --autorizar SHA256 [--id UUID]
```

Con el ID de una vista existente, Mind actualiza esa dirección solo si la
compilación y la validación terminan bien y la vista conserva la versión
vigente al empezar. El informe muestra lo solicitado y lo servido. Durante
la ejecución, el plazo o Ctrl+C cancelan el proceso directo de la receta.

Prueba con Node y Python y una Base ficticia, usando el binario Rust y
`MIND_TEST_BUNDLED_PYTHON` o `MIND_PYTHON`.

```powershell
node --test nativo/test/compilacion-vista.test.mjs
```

## Aplicaciones locales y SQLite (Etapa 4)

En una Base ficticia, inicia el anfitrión con `--puerto-vistas 0 --servicios-prueba`.
Desde la consola local, revisa la receta con `vista receta`, luego utiliza su valor
`autorizacion` para abrir el servicio.

```text
servicio abrir --base ABS --proyecto NOMBRE --copia ABS --receta ABS --autorizar SHA256 [--id UUID]
servicio estado --base ABS --id UUID
servicio cerrar --base ABS --id UUID
```

- **Base de datos.** `MIND_SQLITE` indica el archivo persistente asignado al proyecto
  y a esa copia. La aplicación lo abre con su biblioteca SQLite. Durante un reemplazo
  se comparte el archivo, así que ambas versiones deben ser compatibles con su esquema.
- **Arranque.** Escucha en `MIND_HOST` (`127.0.0.1`) y elige un puerto libre con
  `MIND_PORT` (`0`). Escribe `{"puerto": N}` en `MIND_LISTO` y responde a `GET /health`
  con éxito y la cabecera `X-Mind-Listo` igual a `MIND_LISTO_TOKEN`. La comprobación de
  salud es de solo lectura.
- **Apertura.** El enlace de Mind lleva a la aplicación que está lista. Con un ID
  existente, solo cambia de destino tras comprobar la versión nueva. Vuelve a abrir
  el enlace de Mind para llegar al nuevo destino desde una pestaña anterior.
- **Cierre.** `servicio estado` muestra la salud y, en Windows, el número de procesos
  y su memoria residente. `servicio cerrar` apaga el servicio y conserva el archivo
  SQLite. La administración de servicios usa una credencial local de la Base de prueba.

La [prueba de servicios](test/servicios-sqlite.test.mjs) incluye una aplicación
ficticia con SQLite y un proceso hijo. Ejecútala con el binario Rust en
`MIND_NATIVE_EXE`.

```powershell
node --test nativo/test/servicios-sqlite.test.mjs
```

## Archivos y significado (Etapa 5)

El anfitrión de pruebas puede indicar una ruta absoluta en `nativeTextReaderExecutable` para leer
texto en Rust, y en `nativeFilesExecutable` para crear y modificar texto,
copiar resultados, organizar archivos y extraer texto de DOCX, XLSX, PPTX, ODT,
ODS y ODP. Las dos opciones se pasan al abrir una sesión ficticia. Los permisos
se vuelven a comprobar tras abrir el archivo o su carpeta. La modificación en
macOS requiere completar la conservación de metadatos.

`nativeMeaningExecutable` elige el buscador experimental. Compara palabras
y aprende asociaciones del proyecto.
Busca en los resúmenes autorizados y conserva la distinción entre ideas y decisiones.
La comparación es local y usa únicamente conversaciones ficticias. En la búsqueda
híbrida con E5, si ambos métodos encuentran una nota se muestra el pasaje elegido
por significado. Las consultas de identificadores conservan su extracto por palabras.

```powershell
$env:MIND_TEST_NATIVE_TEXT_READER = $env:MIND_NATIVE_EXE
$env:MIND_TEST_NATIVE_FILES = $env:MIND_NATIVE_EXE
node --test test/text-reader.test.js test/text-creator.test.js test/text-modifier.test.js test/organize-agent.test.js test/work-destinations.test.js
$env:MIND_TEST_NATIVE_MEANING = $env:MIND_NATIVE_EXE
node --test nativo/test/significado.test.mjs
```

`MIND_TEST_BUNDLED_PYTHON` permite usar el Python portable como referencia.
La evaluación puede comparar con E5 local al indicar `MIND_TEST_E5_DIRECTORY`.

## Lectura de continuidad por ID (Etapa 6)

La prueba de la vista compartida puede usar el anfitrión Rust para abrir y leer
el archivo de continuidad por ID. El Motor Node conserva el permiso de lectura,
la validación del registro y la escritura de la Base y del Markdown. La prueba
arranca el anfitrión y el Motor con una clave interna de un solo arranque. El
token de los agentes no da acceso a la lectura de registros en bruto.

Con el binario Rust en `MIND_NATIVE_EXE` y Python portable en
`MIND_TEST_BUNDLED_PYTHON`, compara los dos modos sobre Bases temporales nuevas:

```powershell
node --test nativo/test/vista-compartida.test.mjs
$env:MIND_TEST_NATIVE_CONTINUITY = '1'
node --test nativo/test/vista-compartida.test.mjs
Remove-Item Env:MIND_TEST_NATIVE_CONTINUITY
```

La prueba guarda en Node y retoma desde otra sesión después de cerrar la
primera. Verifica los archivos y el permiso antes y después de revocarlo.
Con la lectura Rust activa, parar el anfitrión hace fallar la lectura por ID
aunque Node siga atendiendo.

Para usar el lector desde un arranque local de desarrollo, inicia el anfitrión
sobre la misma Base que usará el Motor. Pasa a ambos procesos la misma
`MIND_CLAVE_LECTURA_CONTINUIDAD` aleatoria de 64 caracteres hexadecimales.
En el arranque del Motor indica también `MIND_PUERTO_LECTURA_CONTINUIDAD`
con el puerto que publica el anfitrión en `anfitrion.json`. Sin este puerto,
el Motor sigue leyendo sus registros directamente.

## Ensayo de escritura y vuelta a r3 (Etapa 6)

Con el binario Rust en `MIND_NATIVE_EXE`, ejecuta la prueba desde el repositorio:

```powershell
node --test nativo/test/continuidad-vuelta-r3.test.mjs
```

La prueba extrae el código del tag local `v1.0.4-r3` en una carpeta temporal y
crea una Base ficticia con ese Motor. Espera a que termine r3, ejecuta el escritor
Rust y espera su salida antes de reabrir la misma Base con r3. El comando de
prueba crea un registro de formato 1 sin sobrescribir archivos. La prueba
verifica el nuevo registro por ID, su referencia al registro anterior y que la
lectura de r3 conserva los bytes de ambos registros y de la marca de la Base.

## Guardado normal con el anfitrión Rust (Etapa 6)

Una sesión de desarrollo que ya usa la lectura nativa puede seleccionar al
mismo anfitrión como escritor de los registros de continuidad y las
escrituras de texto en Windows y Linux. Activa `MIND_ESCRITURA_NATIVA=1` al arrancar ambos procesos.
Las herramientas normales conservan permisos, revisiones y destinos. El
anfitrión abre el archivo de forma segura y espera que el Motor confirme el
permiso. El JSON y el Markdown se publican en el orden habitual, con una
operación atómica por archivo y el estado explícito de Markdown pendiente si
falla ese paso. Para completar el archivo, pasa el objeto `reintento` a
`actualizar` (o a `conversacion_guardar` en el catálogo completo). El ID y la
revisión se mantienen. Mind solo sustituye un Markdown cuando coincide con la
huella guardada antes del fallo. Si ya contiene la nota, confirma sin escribir
otra vez. Para registros anteriores que carecen de huella, un Markdown
existente con contenido distinto se conserva. Una vez elegido Rust, el
guardado depende de ese anfitrión.

Para comprobar permisos, creación, actualización y vuelta a r3 con una Base
ficticia y `MIND_NATIVE_EXE` definido:

```powershell
$env:MIND_TEST_NATIVE_SAVE = '1'
node --test nativo/test/vista-compartida.test.mjs
Remove-Item Env:MIND_TEST_NATIVE_SAVE
```

## Motor Rust autónomo y vuelta a r3 (Etapa 6)

El comando de desarrollo `motor --base ABS` abre una Base r3 de formato 3
con los permisos vigentes del disco. Arranca la entrada HTTP MCP de loopback
y devuelve su URL y la credencial de sesión a quien lo inició. El anfitrión,
el protocolo, los permisos y el guardado se ejecutan dentro del mismo proceso.
El bloqueo de propietario es compatible con r3, que puede recuperar la Base
después de comprobar que ese proceso terminó. La credencial es local al
arranque y debe tratarse como privada.

Esta entrada prueba estado, guardado y actualización de conversaciones y
continuidad, retoma por ID, búsqueda por palabras en las conversaciones y
las operaciones básicas de texto. Las demás herramientas siguen en relevo.
La entrada sirve para probarlo en Windows y Linux.

Con `MIND_NATIVE_EXE` y el Python portable de r3 en
`MIND_TEST_BUNDLED_PYTHON`, el ensayo extrae el código del tag `v1.0.4-r3`,
prepara una Base temporal y arranca Rust con dos sesiones MCP. Comprueba el
PID y el árbol de procesos, interrumpe el único proceso de Mind y arranca
el Motor r3 extraído para verificar datos y permisos sobre la misma Base.
Windows puede iniciar su consola del sistema (conhost.exe) por separado.
El ensayo conserva también un registro con Markdown pendiente para comprobar
qué recupera r3 después del corte.

```powershell
node --test nativo/test/motor-nativo-vuelta-r3.test.mjs
```

## Arranque habitual con Rust

En desarrollo, usa el iniciador habitual con `MIND_MOTOR_NATIVO=1` y
`MIND_MOTOR_NATIVO_EXE` como ruta absoluta al ejecutable compilado. Rust crea la
Base en formato 3 si aún no existe, publica el conector habitual y el lanzador
sale tras comprobarlo.
Dos conexiones HTTP comparten el mismo proceso y el bloqueo de la Base.
Un cliente configurado para stdio sigue usando su puente.

El Motor aplica los permisos persistidos y el ámbito abierto que comunica el
iniciador o el cliente. El acceso nuevo requiere el formulario del cliente o
queda pendiente para la consola habitual. Con el Motor Rust activo,
`mind autorizar` y `mind permisos` operan a través de ese único proceso
escritor (incluida la retirada parcial de permisos o completa de carpetas y la
revisión de borrados y vaciados de papelera con doble confirmación) usando
`conector-consola.json`, una credencial nueva en cada arranque que Rust escribe
y borra al cerrar; el token MCP no puede aprobar ni retirar desde `/rpc`
consola. El Motor Rust mantiene además el índice persistido de cada carpeta
(`folder-index-<id>.json`), el registro de la papelera (`trash-<id>.json`), el
rastro de eliminados (`folder-removed-<id>.json`), la lectura por secciones y
de documentos de oficina, la edición puntual y la búsqueda por texto. Las
consultas consecutivas reutilizan el índice durante un segundo. Pasado ese
intervalo, la siguiente consulta comprueba cambios externos. Las operaciones
de Mind actualizan el índice al completar el cambio.

Mind guarda la intención de un traslado antes de mover el archivo. Si falla
la actualización de rutas, Rust o r3 la completan al retomar la conversación.
Para enviar algo a la papelera, Rust publica primero su registro compatible
con r3. Si ese guardado falla, el archivo permanece en su ubicación original.

Rust sigue siendo optativo mientras se portan las funciones restantes.

Para volver a r3, cierra el Motor Rust, quita la selección nativa del iniciador
y abre la misma Base con r3. Ambos usan el mismo bloqueo y formato de Base. El
ensayo extrae el tag local de r3 y prueba esa vuelta tras interrumpir Rust.

```powershell
node --test nativo/test/arranque-rust-vuelta-r3.test.mjs
```

## Compilación reproducible

`build.ps1` quita del ejecutable las rutas locales (`--remap-path-prefix`) y,
en Windows, la marca de fecha del formato PE (`--no-insert-timestamp`). El
mismo código y la misma toolchain producen el mismo archivo desde cualquier
carpeta. Comprobado el 19-nov-2026 compilando desde dos rutas distintas:

| Destino | SHA-256 |
|---|---|
| win32-x64 (GNU, rust-lld) | `d0948ebfe62c1d06637932f3803416d728b04bb5b24fca2debf935a415a8045f` |
| linux-x64 (musl, rust-lld) | `b28f863fbd8e8f43cca17aae09da410e33b0fd461652a9d59fe19e187b0b2a05` |

Toolchain: Rust 1.100.0 del piloto. Otra versión del compilador da otra huella.

## Estado de los seis destinos

| Destino | Compilado | Ejecutado |
|---|---|---|
| win32-x64 | Sí, en este equipo | Sí, en este equipo: 13/13 pruebas + contrato |
| linux-x64 | Sí, en este equipo (cruzado) | No: sin Linux ni WSL aquí; en CI cuando corra |
| linux-arm64 | Sí, en este equipo (cruzado) | No |
| win32-arm64 | Solo en CI (MSVC) | No |
| darwin-arm64 | Solo en CI (macos-14) | En CI cuando corra |
| darwin-x64 | Solo en CI (macos-14, cruzado) | No |

El flujo de CI se lanza a mano (`workflow_dispatch`). Hasta el 19-nov-2026 no
se ha ejecutado: la cuota de Actions de la cuenta está agotada. Lo no ejecutado
en su sistema se declara así.

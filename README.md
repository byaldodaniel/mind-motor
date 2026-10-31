# Mind 1.0 — Motor

Núcleo local construido desde cero. Utiliza JavaScript con módulos ESM y Node.js
24 LTS, sin dependencias externas, compilación ni instalación de paquetes.

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

## Pruebas

```sh
node --test
```

También se puede usar `npm test`; no requiere `npm install`. La suite cubre arranque,
lectura/escritura, reinicio entre procesos, independencia de Bases y código,
validación de rutas y entradas, datos corruptos y limpieza ante fallos.
GitHub Actions ejecuta la misma suite en Windows, macOS y Linux con Node.js 24.

## Interfaces y alcance

La API programática y los límites para extender el núcleo están documentados en
[docs/INTERFACES.md](docs/INTERFACES.md). Todavía no hay indexación, agentes,
automatizaciones, continuidad, servidores ni interfaz gráfica. Los registros
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

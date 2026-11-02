# Distribución portable de Mind (Hito A)

Mind se distribuye como una carpeta comprimida por sistema. El usuario la extrae,
abre la carpeta `Mind` con Claude Code y empieza a trabajar: no instala Node.js,
Python ni dependencias, y no configura MCP. La guía para el usuario es el
`LEEME.md` del paquete (`packaging/plantilla/LEEME.md`).

## Paquetes

| Paquete | Sistema | Formato | Probado en CI |
|---|---|---|---|
| `Mind-<versión>-linux-x64.tar.gz` | Linux x64 (glibc) | tar.gz | `ubuntu-latest` |
| `Mind-<versión>-linux-arm64.tar.gz` | Linux arm64 (glibc) | tar.gz | `ubuntu-24.04-arm` |
| `Mind-<versión>-darwin-arm64.tar.gz` | macOS Apple Silicon | tar.gz | `macos-latest` |
| `Mind-<versión>-darwin-x64.tar.gz` | macOS Intel | tar.gz | `macos-15-intel` |
| `Mind-<versión>-win32-x64.zip` | Windows x64 | zip | `windows-latest` |

El workflow [Paquetes portables](../.github/workflows/paquetes.yml) los construye
en cada push y los deja como artefactos de la ejecución, con `SHA256SUMS` y el
informe de prueba de cada sistema. No es una publicación de producción. GitHub
entrega cada artefacto dentro de un .zip propio: hay que descomprimirlo una vez
para obtener el paquete.

## Contenido

```
Mind/
  .mcp.json                 servidor MCP "mind" del proyecto, con rutas relativas
  AGENTS.md, CLAUDE.md      instrucciones para agentes (CLAUDE.md importa AGENTS.md)
  LEEME.md                  guía de primer uso
  LICENCIA.txt, LICENCIAS/  licencia de Mind y de Node.js y CPython, con sus orígenes y huellas
  mind | mind.cmd           iniciador del sistema
  Autorizar Mind.command | .cmd   consola de autorización con doble clic (macOS, Windows)
  mind-producto.json        manifiesto: versión, plataforma, componentes y SHA-256 de cada archivo
  Motor/                    bin/, src/, package.json, LICENSE, docs/PRODUCTO.md
  Runtime/node/             solo el ejecutable de Node.js 24.22.1 y su licencia
  Runtime/python/           CPython 3.12.14 (python-build-standalone 20260929, install_only_stripped)
```

`Base/` no viaja en el paquete: Mind la crea en el primer uso, dentro de la
carpeta `Mind`, y ningún agente puede autorizar la carpeta `Mind` ni nada dentro
de ella.

- `.mcp.json` lanza el Node incluido directamente (`Runtime/node/bin/node
  Motor/bin/mind.js mcp`, o `Runtime\node\node.exe Motor\bin\mind.js mcp`), sin
  intérprete de órdenes, y vacía `NODE_OPTIONS`.
- Claude Code inicia el servidor con la carpeta abierta como directorio de
  trabajo. Por eso hay que abrir Claude Code en la carpeta `Mind`.
- El iniciador `mind` usa solo órdenes internas del shell, así que funciona aunque
  el PATH esté vacío. `mind.cmd` usa `%~dp0`.

## Construir

```bash
node scripts/construir-paquetes.mjs --sumas-oficiales
```

```bash
node scripts/construir-paquetes.mjs --plataforma linux-x64 --salida dist
```

- **Componentes:** se descargan de las URL de `packaging/componentes.json` y se
  rechazan si su SHA-256 no coincide. `--sumas-oficiales` contrasta además esas
  huellas con `SHASUMS256.txt` de Node.js y `SHA256SUMS` de python-build-standalone.
  La caché está en `.cache/descargas/`.
- **Motor:** solo archivos versionados en git (`git ls-files`). Si hay cambios sin
  commit, el script avisa: ese paquete no es reproducible desde el commit.
- **Reproducible:** entradas ordenadas por bytes, uid/gid 0, permisos
  normalizados, fecha fija igual a la del commit (o `SOURCE_DATE_EPOCH`) y
  cabecera gzip sin fecha ni sistema. El CI construye dos veces y compara
  `SHA256SUMS`.
- **Requisitos:** se construye en Linux o macOS con Node.js 24 y `xz` (los
  archivos de Node para Linux son .tar.xz).
- **Python sin `share/terminfo`:** esa carpeta de CPython es una base de datos de
  terminales para curses que Mind no usa. Contiene nombres que solo difieren en
  mayúsculas y chocarían en macOS y Windows.

## Probar desde la carpeta extraída

```bash
Mind/Runtime/node/bin/node scripts/producto-12-casos.mjs --mind Mind --claude claude --informe informe.json
```

La prueba usa el Node del propio paquete y lanza el servidor como lo declara
`.mcp.json`, con la carpeta `Mind` como directorio de trabajo y un PATH vacío:
cualquier dependencia de un Node o un Python del sistema la haría fallar. En CI
se extrae en una ruta con espacios y con «ñ».

| # | Comprobación | Cómo |
|---|---|---|
| 1 | La carpeta se extrae correctamente | Cada archivo coincide con su SHA-256 en `mind-producto.json`; no hay Base; `.mcp.json` sin rutas absolutas |
| 2 | Los runtimes incluidos funcionan | `node --version` y `python3 -I -B -c "import ssl, sqlite3, zipfile, ctypes"` con PATH vacío |
| 3 | El iniciador ejecuta Mind | `mind version` / `mind.cmd version` con PATH vacío; no crea la Base |
| 4 | Claude Code descubre el servidor | **Claude Code real**: `claude mcp get mind` → `Connected` |
| 5 | El Motor inicializa la Base | Primer `initialize`; marca `mind-base.json`; runtimes dentro del paquete; solo las herramientas del Hito A |
| 6 | Autorizar una carpeta ficticia | Formulario (la respuesta del usuario es simulada); una carpeta dentro de Mind se rechaza |
| 7 | Se genera su índice | El índice queda vigente con los 3 archivos ficticios |
| 8 | Buscar y leer | `buscar`, `leer` (con versión) y `explorar` |
| 9 | Crear y modificar | `crear` sin sobrescribir; `editar` y `modificar` con control de versión |
| 10 | Registrar continuidad | `continuidad_registrar`, `continuidad_exportar` e importar el paquete |
| 11 | Cerrar sin procesos residentes | Código 0, sin registro de sesión ni bloqueos; ningún proceso con la ruta de Mind |
| 12 | Reabrir y recuperar | Otro proceso con otro agente declarado; recupera la continuidad, el archivo nuevo, el borrado y el cambio de contenido hechos con Mind cerrado |

Salvo la 4, las comprobaciones de Mind con un agente usan un cliente MCP de
prueba que simula al agente y la respuesta del usuario. El informe lo indica en
cada caso (`tipo`). La aprobación del servidor de proyecto en la comprobación 4
se registra en una configuración temporal y aislada de Claude Code
(`enabledMcpjsonServers`): el paquete no la trae preaprobada.

En macOS, `scripts/producto-cuarentena-macos.mjs` comprueba otra copia extraída
marcada con `com.apple.quarantine`. Mind verifica sus runtimes, retira la marca
solo dentro de `Runtime/`, y el Python incluido indexa y lee una carpeta. Esto no
reproduce el diálogo de Gatekeeper.

La prueba con el modelo real desde la carpeta extraída está en
[`evidencia/HITO_A_AGENTE_REAL_2026-11-02.md`](evidencia/HITO_A_AGENTE_REAL_2026-11-02.md).

## Resultados del Hito A

Ejecución [41369923501](https://github.com/byaldodaniel/mind-motor/actions/runs/41369923501),
commit e344011. Los paquetes probados se descargan desde esa página, en
*Artifacts*.

| Paquete | SHA-256 | 12 comprobaciones | Claude Code real (4) | Cuarentena |
|---|---|---|---|---|
| `Mind-1.0.0-rc.1-linux-x64.tar.gz` | `75e179cd3060eb2c3034a05413b30ccb12c8a05eb41648b943fc2961b1028645` | 12/12 | Conectado | — |
| `Mind-1.0.0-rc.1-linux-arm64.tar.gz` | `f21d257ee7a8b05a827cd53e6146573f83c3318913995d3f32890934d6a25752` | 12/12 | Conectado | — |
| `Mind-1.0.0-rc.1-darwin-arm64.tar.gz` | `ba3d6d90ac4c89fee3c4278a238dcba67d6b7b76bb196fa1bfd4129712e711da` | 12/12 | Conectado | Superada |
| `Mind-1.0.0-rc.1-darwin-x64.tar.gz` | `6b8a937f351c7f300376af42d3a6bc8c07817875e3f51100e52165c5f2901762` | 12/12 | Conectado | Superada |
| `Mind-1.0.0-rc.1-win32-x64.zip` | `7ef0076e384d3b7ebf0322254c383c83f7ac15105ec40bc1495d0c26a5e3253a` | 12/12 | Conectado | — |

- **Reproducibilidad:** la segunda construcción del CI coincide byte a byte con
  la primera. Una construcción independiente en otro equipo (contenedor de
  desarrollo, Node 24.22.1) dio las cinco mismas huellas.
- **Modelo real:** con el paquete Linux x64 anterior,
  [`evidencia/HITO_A_AGENTE_REAL_2026-11-02.md`](evidencia/HITO_A_AGENTE_REAL_2026-11-02.md).
- **Sin modelo real:** en macOS y Windows, Claude Code real solo descubrió y conectó
  el servidor. El resto del recorrido lo hizo el cliente MCP de prueba.
- **Commits posteriores:** cambian la fecha y el commit del manifiesto, y con ellos
  las huellas. Cada ejecución del workflow vuelve a probar sus paquetes.

## Límites conocidos

- **Sin firma de código.** Decisión aprobada: no pagar certificados.
  - En macOS, Gatekeeper puede bloquear el doble clic en `Autorizar Mind.command`;
    se abre con clic derecho → *Abrir* o con `./mind autorizar`. Node.js viene
    firmado y notarizado por su proyecto. El Python incluido no está notarizado:
    Mind retira la cuarentena de `Runtime/` solo tras verificar sus huellas.
  - En Windows, SmartScreen puede avisar al abrir `Autorizar Mind.cmd` desde un
    zip descargado.
  - Ninguna de estas dos experiencias la ha comprobado una persona.
- **El formulario de autorización interactivo** de Claude Code no se ha probado
  con una persona. En modo `-p` se cancela y la solicitud queda pendiente para
  `mind autorizar`, que sí se probó.
- **Solo Claude Code.** El paquete no configura otros clientes MCP. Los agentes
  con terminal pueden usar `mind herramienta`.
- **Linux con glibc.** No hay paquete para musl (Alpine) ni para Windows en arm64.
- **Actualizar** en esta versión es extraer el paquete nuevo y trasladar la
  carpeta `Base` con el agente cerrado. `mind actualizar` es del Hito B.
- **Integridad no es seguridad.** Las huellas demuestran que los archivos son los
  publicados y que el paquete no cambió. No garantizan que los componentes estén
  libres de defectos.

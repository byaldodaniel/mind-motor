# Mind 1.0 como producto portable

**Mind es un motor que permite a los agentes de IA trabajar la información del
usuario, a su manera.** El usuario dirige, los agentes interpretan y ejecutan,
Mind aporta las capacidades técnicas, y los archivos del usuario conservan la
información original.

## La carpeta es el producto

```
Mind/
  mind (macOS, Linux) o mind.cmd       iniciador (sin instalar nada)
  Autorizar Mind.command / .cmd        consola de autorización con doble clic (macOS, Windows)
  mind-producto.json                   manifiesto: versión, plataforma y SHA-256 de cada archivo
  AGENTS.md, CLAUDE.md, GEMINI.md      instrucciones de reconocimiento para agentes
  LEEME.md, LICENCIA.txt, LICENCIAS/   guía de primer uso y licencias
  .mcp.json                            servidor MCP "mind" del proyecto para Claude Code (rutas relativas)
  Motor/                               código del Motor; se sustituye al actualizar
  Runtime/node, Runtime/python         runtimes incluidos (Node.js 24, CPython 3.12)
  Base/                                datos persistentes; se crea en el primer uso
```

Motor y Base son independientes. La Base no forma parte del paquete: actualizar
sustituye `Motor/` y `Runtime/` y nunca toca `Base/`. Una Base creada por una
versión posterior no se abre con un Motor anterior (`BASE_TOO_NEW`): no se modifica.

Ninguna carpeta autorizada puede contener la carpeta de Mind ni estar dentro de
ella. Así ningún agente puede modificar los iniciadores, los runtimes ni la Base
mediante Mind.

## Experiencia de uso

1. **Descargar y extraer** la carpeta. No requiere administrador.
2. **Abrirla desde un agente compatible.** Con Claude Code, en un terminal dentro
   de la carpeta: `claude`. El cliente encuentra `.mcp.json` y pregunta una vez si
   se usa el servidor `mind`: es el consentimiento del usuario para ejecutar el
   programa.
3. **Autorizar la información necesaria.** Cuando el agente necesita una carpeta,
   Mind pide al cliente que muestre un formulario al usuario con la ruta y una
   elección: solo encontrar, encontrar y leer, o acceso completo. Se pueden
   excluir subcarpetas. Si el cliente no puede mostrar formularios, la solicitud
   queda pendiente y el usuario la aprueba con `mind autorizar` o con doble clic
   en «Autorizar Mind».
4. **Trabajar.** El agente busca en índices persistentes, lee y escribe con
   control de versiones, organiza y registra decisiones y resultados.
5. **Continuidad.** Otra sesión u otro agente retoman el trabajo desde la
   continuidad de la Base. Al volver a abrir Mind, los índices recuperan lo que
   cambió mientras estuvo cerrado.

## Sesión ligada al agente

- **Inicio:** el cliente lanza `mind mcp` por stdio. Mind abre la Base, o la crea
  en el primer uso con su marca de formato; recupera autorizaciones y decisiones;
  y empieza a reconciliar cada carpeta registrada sin bloquear al agente.
- **Durante:** el observador mantiene los índices al día. Las notificaciones del
  sistema solo deciden cuándo reconciliar; el recorrido seguro decide qué se
  publica.
- **Final:** al cerrarse stdin o recibir una señal, Mind detiene observadores y
  temporizadores y elimina su registro de sesión. No queda ningún proceso
  residente.
- **Sin sesiones persistentes:** `mind herramienta <nombre> [json]` ejecuta la
  misma herramienta en una operación individual, con reconciliación bajo demanda.
  No es observación continua.

## Herramientas del agente

| Herramienta | Requiere | Qué hace |
|---|---|---|
| `estado` | — | Carpetas, niveles de acceso, exclusiones, índices, continuidad y solicitudes pendientes |
| `solicitar_acceso` | decisión del usuario | Pide una carpeta (`acceso`: encontrar, leer o completo) o la continuidad |
| `retirar_acceso` | — | Reduce permisos, excluye subcarpetas o retira la carpeta |
| `buscar` | encontrar | Por nombre o ruta, con filtros de tipo, extensión, subcarpeta, tamaño y fecha, sobre el índice |
| `explorar` | encontrar | Contenido de una carpeta o subcarpeta desde el índice |
| `eliminados` | encontrar | Lo que desapareció en los últimos 30 días (solo metadatos) |
| `leer` | leer | Texto UTF-8 de hasta 1 MiB, con su versión; texto de .docx, .xlsx, .pptx, .odt, .ods y .odp (solo lectura) |
| `crear` | escribir | Archivo nuevo; nunca sobrescribe |
| `modificar` | escribir | Sustituye el contenido si la versión coincide |
| `editar` | leer y escribir | Reemplazos exactos con control de versión |
| `continuidad_*` | continuidad | Registrar, consultar, actualizar, exportar e importar |

| `crear_carpeta`, `mover`, `renombrar` | organizar | Nunca reemplazan; las propiedades siguen al elemento |
| `borrar`, `papelera`, `restaurar`, `vaciar_papelera` | organizar (papelera: encontrar) | Papelera de Mind recuperable; borrar se confirma cada vez y vaciar dos veces |
| `propiedades`, `asignar_propiedades` | encontrar / organizar | Etiquetas en la Base, sin modificar el archivo; `buscar` filtra por ellas |
| `indices_personalizados`, `crear_indice`, `actualizar_indice`, `modificar_indice`, `retirar_indice` | encontrar y escribir | Índices en CSV dentro de una carpeta autorizada; no sobrescriben ediciones externas |
| `funciones`, `crear_funcion`, `modificar_funcion`, `retirar_funcion`, `ejecutar_funcion`, `activar_funcion`, `desactivar_funcion`, `historial_funcion` | según el ejecutor | Catálogo fijo de ejecutores; la activación automática la autoriza el usuario |
| `crear_respaldo` | — | Respaldo cifrado de la Base en el destino configurado por el usuario |

Las herramientas del Hito B se registran mediante `src/tools/index.js` y están
probadas en Linux y Windows (`node scripts/test.mjs` y los 23 casos de
`scripts/producto-12-casos.mjs` desde la carpeta extraída). macOS sigue pendiente.

## Consentimiento y permisos

- **Solo el usuario concede.** Por formulario del cliente (elicitación MCP) o por
  la consola de Mind. Ni una ruta, ni un id de carpeta, ni lo que diga el agente
  conceden permisos.
- **Permisos separados por carpeta:** encontrar (metadatos), leer (contenido),
  escribir (crear y modificar) y organizar. El usuario los elige como un único
  nivel; Mind los guarda por separado.
- **Ligados a la autorización:** si se retira una carpeta y se vuelve a autorizar,
  las decisiones anteriores no se reactivan.
- **Exclusiones:** lo excluido no se recorre, no se indexa y no se lee ni escribe.
- **Retirar** o reducir permisos nunca requiere confirmación. **Ampliarlos** sí.
- **Operaciones del agente:** cada lectura o escritura usa un permiso de un solo
  intento del Motor, ligado a la identidad opaca de la conexión. El agente nunca
  recibe el Motor administrativo.
- **Auditoría:** `Base/auditoria.jsonl` registra autorizaciones, cambios de
  permisos y operaciones sobre originales (rutas, tamaños y versiones; nunca
  contenido).

## Garantías y límites

- Los originales permanecen en su ubicación y no se copian a la Base. La Base sí
  contiene metadatos (nombres, rutas, fechas) y la continuidad: debe tratarse como
  información del usuario.
- Mind no sigue enlaces que salgan de una carpeta autorizada y abre los archivos
  por referencias de directorio.
- **Mind no es un aislamiento de seguridad del sistema operativo.** Un agente que
  ya ejecuta programas con los permisos del usuario conserva esos permisos y
  puede eludir cualquier mecanismo de ese mismo usuario, incluida la consola (por
  ejemplo, emulando un terminal) o la propia Base. Las garantías de Mind cubren lo
  que se hace a través de Mind.
- La identidad del agente es la que declara su cliente; Mind la muestra como
  «declarada» y no la usa como permiso.

## Compatibilidad

| Agente | Estado |
|---|---|
| Claude Code 2.1.316 (CLI) | Verificado desde la carpeta extraída del paquete: descubrimiento y conexión del servidor de proyecto (`docs/DISTRIBUCION.md`) y sesiones reales con el modelo (`docs/evidencia/`). En modo sin interfaz (`-p`) el formulario se cancela y la solicitud queda pendiente para la consola. |
| Codex CLI 0.156.1, Gemini CLI 0.61.0 | El usuario registra el servidor una vez (`LEEME.md`). Verificado en Windows: el registro con `codex mcp add` y `gemini mcp add` y la conexión del servidor lanzado desde otro directorio. Gemini lo deja desactivado hasta que el usuario confía en la carpeta. Sin sesión real con el modelo en esta versión. |
| Otros clientes MCP | Servidor stdio: `Runtime/node` + `Motor/bin/mind.js mcp`, con `NODE_OPTIONS` vacía. |
| Agentes sin MCP con terminal | `mind herramienta …` (operaciones individuales). |

## Órdenes para el usuario

| Orden | Uso |
|---|---|
| `mind estado` | Resumen de la Base, las carpetas y sus permisos |
| `mind autorizar [ruta]` | Aprueba solicitudes pendientes o autoriza una carpeta |
| `mind permisos [retirar\|excluir\|incluir …]` | Revisa y cambia permisos |
| `mind reparar` | Limpia bloqueos y temporales tras un cierre abrupto |
| `mind version` | Versiones |

| `mind actualizar <paquete> [--forzar]` | Sustituye Motor y runtimes por los de un paquete nuevo y conserva la Base (la versión anterior queda en `.anterior-<versión>`) |
| `mind respaldo configurar|crear|estado|verificar|restaurar` | Respaldos cifrados de la Base y su recuperación |
| `mind programador instalar|estado|desinstalar` | Funciones automáticas autorizadas también con Mind cerrado |
| `mind programadas` | Ejecuta los turnos vencidos (lo usa el programador del sistema) |

Estas órdenes se registran mediante `src/commands/index.js`.

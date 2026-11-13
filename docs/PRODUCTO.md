# Mind 1.0.4 como producto portable universal

Mind permite a los agentes trabajar la información del usuario a su manera. La versión 1.0.4 introduce el Motor Central compartido («Un Solo Latido») para coordinar múltiples sesiones de agentes sobre la misma carpeta sin bloqueos en la Base.

## La carpeta es el producto

```text
My Mind/
  LEEME.md
  AGENTS.md, CLAUDE.md, GEMINI.md, .mcp.json (según cliente)
  Conversaciones/
  Sistema/
    mind, mind.cmd y entradas de autorización
    Programa/Motor/
    Componentes/Node/<destino>/
    Componentes/Python/<destino>/
    Componentes/Semantica/
    Base/
    Estado/
    Licencias/
    Actualizaciones/
    mind-producto.json
    entrega-firmada.json
```

El ZIP único incluye los cinco destinos y sus ejecutores listos al extraer, sin descargas adicionales. La Base se crea al primer uso y nunca forma parte del paquete. Los resultados se guardan en Conversaciones salvo destino elegido. Las Bases externas conservan su ubicación; el formato de datos no cambia en esta corrección.

El programa y los componentes sustituibles están separados de los datos persistentes. La actualización verifica la entrega firmada, reutiliza componentes iguales y conserva recuperación únicamente durante la operación. Tras confirmar se eliminan temporales y código anterior: el usuario tiene una instalación vigente, sin histórico de paquetes.

Las copias antiguas se actualizan desde el paquete corregido mediante su agente, manteniendo su ruta y datos. My Mind es el nombre por defecto de nuevas descargas. Véase CIERRE_1_0_3.md en desarrollo para la transición y WORKFLOW_PUBLICACION.md para el artefacto y pruebas.

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

## Motor Central y puente por sesión

- **Inicio:** el cliente lanza `mind mcp` por stdio. Ese proceso actúa como puente
  liviano conectado al Motor Central compartido de la carpeta (`src/motor-central.js`):
  el primer cliente lo enciende y los siguientes lo reutilizan (`src/connector.js`).
  El Motor Central abre la Base una sola vez, recupera autorizaciones y
  decisiones y coordina los índices y observadores sin bloquear al agente.
- **Durante:** el observador mantiene los índices al día y la cola inteligente
  (`src/smart-queue.js`) atiende lecturas en paralelo y escrituras ordenadas por
  carpeta. Con `mind mcp --direct` puede ejecutarse una sesión aislada en el
  propio proceso si hace falta.
- **Reposo y final:** al desconectarse un chat se cierra su puente stdio; tras 3 min
  sin llamadas el Motor Central pasa a reposo ligero y tras 10 min sin llamadas
  se apaga de forma ordenada sin dejar sesiones colgadas (`mind apagar` lo detiene
  al instante).
- **Órdenes directas:** `mind herramienta <nombre> [json]` y `mind inicio` /
  `mind estado` operan coordinadas con el Motor Central por `/rpc`. Ver
  `docs/MOTOR_CENTRAL.md`.

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

## Almacén de conversaciones y resultados

La instalación crea `Conversaciones/` junto a `Base/` en la primera sesión. Es contenido del usuario: memorias importantes y resultados nuevos predeterminados. Se puede elegir otro almacén general, por tipo, por proyecto o por conversación mediante el agente. El manifiesto y las actualizaciones excluyen `Conversaciones/`; Base/Motor/Runtime mantienen sus protecciones. No se añade una carpeta Trabajo. La ubicación del historial nativo de cada cliente sigue bajo control de ese cliente.

## Inicio automático en los agentes

El primer uso del iniciador de una instalación prepara un bloque de instrucciones en los clientes detectados: Codex (`CODEX_HOME/AGENTS.md`, o su override activo), Claude Code (`~/.claude/CLAUDE.md`) y Antigravity (`~/.gemini/GEMINI.md`). Los clientes cargan esas reglas al iniciar conversaciones conforme a sus mecanismos propios. Al corregir una copia se actualizan solo conexiones MCP existentes que apuntan al ejecutor y entrada conocidos de esa misma instalación: Codex, Claude Code, Gemini CLI y Antigravity conservan sus configuraciones separadas. No se crean servidores globales ausentes ni se modifican entradas personalizadas de otra instalación, autenticación, variables de entorno u opciones ajenas. Los cambios se limitan a command, la ruta de entrada y el argumento --base o el valor MIND_BASE cuando apuntaban exactamente a la Base predeterminada cuya migración se verificó.

El bloque ordena consultar `destinos_consultar` antes de trabajar; cuando MCP no está disponible utiliza el Node incluido y `Motor/bin/mind.js inicio` desde el proyecto abierto. La orden devuelve las instrucciones de Mind y su plan de destinos sin argumentos JSON. Las preferencias de proyecto se consultan cuando el agente conoce el proyecto; no se inventa un nombre por la carpeta.

La preparación conserva texto fuera de su bloque, evita duplicados, respeta el override de Codex y actualiza solo su ruta al mover la instalación. Los archivos enlazados, especiales, excesivos o bloques ambiguos se dejan intactos y se informa estado parcial. `mind preparar` muestra el resultado por cliente. Los perfiles ausentes no se crean.

Las pruebas y automatizaciones pueden usar `MIND_AGENT_STARTUP=0` para omitir escrituras globales; esta variable no concede acceso a originales. Las pruebas de Mind la fijan para aislar sus instalaciones ficticias. El arranque guía al agente; no garantiza obediencia a instrucciones que un administrador o un proyecto haya sustituido.

Referencias del mecanismo: [Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Claude Code](https://code.claude.com/docs/en/memory), [Antigravity](https://antigravity.google/docs/rules-workflows).

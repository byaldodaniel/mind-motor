# Mind

Mind es un motor que permite a los agentes de IA trabajar tu información, a tu
manera. Tus archivos permanecen donde están: Mind no los copia. En su carpeta
`Base` guarda índices, autorizaciones y la continuidad de tus trabajos.

Esta carpeta ya contiene todo lo que Mind necesita (incluidos Node.js y Python).
No hay que instalar nada ni configurar nada. Solo necesitas un agente:
[Claude Code](https://claude.com/claude-code) (en el terminal o en la app de
Claude) lo reconoce solo; otros agentes con MCP se conectan con un paso (véase
*Compatibilidad*).

## Primer uso

1. **Extrae** el archivo descargado donde quieras, por ejemplo en `Documentos`.
   Se crea la carpeta `Mind`. No hace falta ser administrador.
2. **Abre un terminal en la carpeta `Mind`**:
   - macOS: en el Finder, clic derecho sobre la carpeta → *Servicios* →
     *Nuevo terminal en la carpeta* (o `cd` hasta ella en Terminal).
   - Windows: abre la carpeta en el Explorador, escribe `cmd` en la barra de
     direcciones y pulsa Intro.
   - Linux: clic derecho → *Abrir en un terminal*.
3. **Ejecuta `claude`** (o, en la app de Claude, abre una sesión de Code en la
   carpeta `Mind`). La primera vez, Claude Code pregunta si quieres usar el
   servidor MCP `mind` de este proyecto: responde que sí. Esa aprobación es
   tuya; Mind no la concede por ti.
4. **Pide lo que necesites**, por ejemplo: «Usa Mind para buscar mis notas sobre
   el presupuesto en la carpeta Documentos/Proyectos».
5. **Autoriza solo lo que quieras.** Cuando el agente necesite una carpeta, Mind
   te muestra la ruta y eliges: **solo encontrar** (nombres y fechas),
   **encontrar y leer**, o **acceso completo** (leer, crear y modificar). Puedes
   excluir subcarpetas.

Si tu agente no puede mostrar la solicitud, queda pendiente. Apruébala en un
terminal dentro de esta carpeta con `./mind autorizar` (macOS y Linux) o
`mind autorizar` (Windows). En macOS y Windows también puedes abrir
`Autorizar Mind` con doble clic.

## Lo que hace Mind en esta versión

- Indexa las carpetas que autorizas y mantiene los índices al día mientras el
  agente trabaja; al volver a abrirlo, recupera lo que cambió entretanto.
- Busca y explora sobre esos índices, lee texto y documentos de oficina
  (.docx, .xlsx, .pptx, .odt, .ods, .odp; solo lectura), crea archivos nuevos y
  modifica texto con control de versiones (nunca sobrescribe a ciegas).
- Guarda la continuidad (decisiones, resultados, contexto) para retomarla en
  otra sesión o con otro agente, y la exporta o importa.
- Organiza: crea carpetas, mueve y renombra sin reemplazar nunca nada. Borrar
  lleva a la papelera de Mind (`.papelera-mind` dentro de la carpeta), siempre
  con tu confirmación; vaciarla te pide confirmar dos veces.
- Etiqueta archivos con propiedades (sin modificarlos), busca por ellas y
  mantiene índices personalizados en CSV.
- Funciones reutilizables que el agente ejecuta con los permisos que diste; las
  automáticas (por horario o evento) solo con tu autorización, también con Mind
  cerrado mediante `mind programador instalar`.
- Respaldos cifrados de la `Base` (`mind respaldo configurar`), recuperables con
  un código físico o un archivo protegido.

## Lo que conviene saber

- Mind solo funciona mientras tu agente lo usa: no deja programas en segundo
  plano.
- Revisa o retira permisos con `./mind permisos` (`mind permisos` en Windows).
- `Base` contiene datos sobre tus archivos (nombres, rutas, fechas y la
  continuidad). Trátala como información personal y no la compartas.
- Para actualizar Mind, con el agente cerrado: `mind actualizar <paquete nuevo>`
  (`./mind` en macOS y Linux). Sustituye el Motor y los runtimes, conserva tu
  `Base` y guarda la versión anterior en `.anterior-<versión>`.
- Mind no es un aislamiento de seguridad del sistema. Un agente que ya puede
  ejecutar programas con tu usuario tiene los permisos que tu equipo le dé. Mind
  controla lo que se hace a través de Mind.
- macOS: Mind comprueba la huella SHA-256 de sus propios runtimes y solo
  entonces retira la marca de cuarentena dentro de su carpeta `Runtime`. Si
  macOS bloquea `Autorizar Mind` con doble clic, ábrelo con clic derecho →
  *Abrir*, o usa `./mind autorizar` en el terminal.

## Compatibilidad

| Agente | Estado |
|---|---|
| Claude Code (CLI o app de escritorio) | Comprobado desde la carpeta extraída: descubrimiento, conexión y uso. |
| Codex CLI, Gemini CLI y otros agentes con MCP | Se registran una vez (abajo). Conexión del servidor comprobada; uso con el modelo, sin comprobar en esta versión. |
| Agentes con terminal, sin MCP | Operaciones individuales: `./mind herramienta <nombre> '<json>'` (`mind ayuda`). |

### Conectar otros agentes con MCP

Mind es un servidor MCP por stdio. Sustituye `<Mind>` por la ruta absoluta de
esta carpeta (en macOS y Linux, el ejecutable es `<Mind>/Runtime/node/bin/node`):

- **Codex CLI** (configuración de tu usuario):
  `codex mcp add mind --env NODE_OPTIONS= -- "<Mind>\Runtime\node\node.exe" "<Mind>\Motor\bin\mind.js" mcp`
- **Gemini CLI** (solo para esta carpeta): en un terminal dentro de ella,
  `gemini mcp add mind "Runtime\node\node.exe" "Motor\bin\mind.js" mcp`. Abre
  `gemini` aquí y acepta confiar en la carpeta; sin eso, Gemini deja el servidor
  desactivado.
- **Cualquier otro cliente MCP:** orden `<Mind>\Runtime\node\node.exe`,
  argumentos `<Mind>\Motor\bin\mind.js mcp`, transporte stdio, variable
  `NODE_OPTIONS` vacía.

Mind siempre usa la `Base` de esta carpeta, se lance desde donde se lance.
Las autorizaciones de carpetas siguen siendo tuyas en todos los agentes.

Más detalles en `Motor/docs/PRODUCTO.md`. Licencia: `LICENCIA.txt`; componentes
de terceros: `LICENCIAS/`.

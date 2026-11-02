# Mind

Mind es un motor que permite a los agentes de IA trabajar tu información, a tu
manera. Tus archivos permanecen donde están: Mind no los copia. En su carpeta
`Base` guarda índices, autorizaciones y la continuidad de tus trabajos.

Esta carpeta ya contiene todo lo que Mind necesita (incluidos Node.js y Python).
No hay que instalar nada ni configurar nada. Solo necesitas tener
[Claude Code](https://claude.com/claude-code) instalado.

## Primer uso

1. **Extrae** el archivo descargado donde quieras, por ejemplo en `Documentos`.
   Se crea la carpeta `Mind`. No hace falta ser administrador.
2. **Abre un terminal en la carpeta `Mind`**:
   - macOS: en el Finder, clic derecho sobre la carpeta → *Servicios* →
     *Nuevo terminal en la carpeta* (o `cd` hasta ella en Terminal).
   - Windows: abre la carpeta en el Explorador, escribe `cmd` en la barra de
     direcciones y pulsa Intro.
   - Linux: clic derecho → *Abrir en un terminal*.
3. **Ejecuta `claude`**. La primera vez, Claude Code pregunta si quieres usar el
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

Todavía no organiza ni borra archivos, ni hace respaldos o actualizaciones
automáticas: llegarán en próximas versiones.

## Lo que conviene saber

- Mind solo funciona mientras tu agente lo usa: no deja programas en segundo
  plano.
- Revisa o retira permisos con `./mind permisos` (`mind permisos` en Windows).
- `Base` contiene datos sobre tus archivos (nombres, rutas, fechas y la
  continuidad). Trátala como información personal y no la compartas.
- Para actualizar Mind en esta versión: extrae el paquete nuevo en otra carpeta y
  mueve a ella tu carpeta `Base`, con el agente cerrado.
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
| Claude Code (CLI) | Comprobado desde la carpeta extraída: descubrimiento, conexión y uso. |
| Otros agentes con MCP | No configurados en esta versión. |
| Agentes con terminal, sin MCP | Operaciones individuales: `./mind herramienta <nombre> '<json>'` (`mind ayuda`). |

Más detalles en `Motor/docs/PRODUCTO.md`. Licencia: `LICENCIA.txt`; componentes
de terceros: `LICENCIAS/`.

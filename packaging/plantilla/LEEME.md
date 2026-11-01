# Mind

Mind es un motor que permite a los agentes de IA trabajar tu información, a tu
manera. Tus archivos permanecen donde están: Mind no los copia. Mind conserva en
su carpeta `Base` índices, autorizaciones y la continuidad de tus trabajos.

## Empezar

1. Extrae esta carpeta donde quieras (no hace falta instalar nada ni ser
   administrador).
2. Ábrela con tu agente. Con **Claude Code**: abre un terminal en esta carpeta y
   ejecuta `claude`. La primera vez, Claude Code te pregunta si quieres usar el
   servidor `mind` de este proyecto: acéptalo.
3. Pide al agente lo que necesites; por ejemplo: «Usa Mind para buscar mis notas
   sobre el presupuesto en la carpeta Documentos/Proyectos».
4. Cuando el agente necesite una carpeta, Mind te mostrará una solicitud con la
   ruta y los permisos. Solo tú decides. Puedes conceder solo **encontrar**
   (nombres y fechas), además **leer**, **escribir** u **organizar**.

Si tu agente no puede mostrar la solicitud, queda pendiente. Apruébala abriendo
`Autorizar Mind` (doble clic) o ejecutando `./mind autorizar` (`mind autorizar`
en Windows) en esta carpeta.

## Lo que conviene saber

- Mind solo funciona mientras tu agente lo usa: no deja programas en segundo
  plano. Al volver a abrirlo, actualiza los índices con lo que cambió mientras
  estuvo cerrado.
- Puedes revisar y retirar permisos con `mind permisos`.
- `Base` contiene datos técnicos sobre tus archivos (nombres, rutas, fechas,
  continuidad). No compartas esa carpeta. Para conservar una copia segura,
  configura los respaldos cifrados con `mind respaldo`.
- Para actualizar Mind, usa `mind actualizar <paquete-nuevo>`: sustituye el
  Motor y conserva tu Base.
- Mind no es un aislamiento de seguridad del sistema. Un agente que ya puede
  ejecutar programas con tu usuario tiene los permisos que tu equipo le dé. Mind
  controla lo que se hace a través de Mind.

## Compatibilidad

| Agente | Estado |
|---|---|
| Claude Code (CLI) | Comprobado: descubrimiento y conexión del servidor MCP del proyecto. |
| Gemini CLI, Cursor, VS Code, Codex | Configuración incluida, sin comprobar. |
| Agentes sin MCP con terminal | Órdenes individuales con `mind`, sin observación continua. |

Más detalles en `Motor/docs/PRODUCTO.md`.

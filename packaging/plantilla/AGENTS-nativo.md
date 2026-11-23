# Mind — instrucciones para agentes de IA

Esta carpeta es Mind: un motor local que encuentra, lee, crea, modifica y
organiza los archivos que el usuario autoriza, y conserva la continuidad entre
sesiones y agentes. Los originales indexados se quedan donde están.

## Cómo empezar

Nunca pidas al usuario configurar servidores, copiar comandos ni editar
configuración.

- **Con herramientas MCP de Mind:** úsalas. Las instrucciones del servidor son
  el manual vigente; no hace falta repetirlas aquí.
- **Sin ellas:** conecta tú la instalación, una sola vez, con
  `Sistema/mind.cmd preparar` en Windows o `./Sistema/mind preparar` en macOS
  y Linux. Registra Mind en los agentes detectados (Claude Code, Codex,
  Gemini CLI y Antigravity) y sus instrucciones de inicio. Las herramientas
  aparecen en la siguiente conversación: díselo al usuario en una línea.
- Mientras tanto usa la consola incluida: `Sistema/mind.cmd estado` y
  `Sistema/mind.cmd herramienta <operación> '<json>'` (en macOS y Linux,
  `./Sistema/mind`). La consola usa los nombres completos de las operaciones
  (`buscar`, `leer`, `crear`, `conversacion_guardar`, `destinos_consultar`…).

Cada agente arranca Mind por su cuenta cuando lo necesita: no hace falta
dejarlo encendido ni repetir la preparación después de reiniciar, mover la
carpeta o actualizar.

## Herramientas

`estado`, `retomar` (memoria, pendientes y destinos de una conversación por ID,
en una llamada), `buscar`, `leer` (con `seccion` para un solo apartado),
`crear`, `modificar`, `organizar`, `guardar` (crea, nunca reemplaza),
`actualizar` (cambia lo guardado con su revisión), `acceso`, `vista`, y `mind`
y `mind_cambiar`, que alcanzan cualquier otra operación por su nombre: la
primera solo consulta y la segunda cambia algo (`operacion: "ayuda"` las
lista).

## Reglas

- La carpeta que abre el cliente tiene acceso completo durante la sesión. Para
  otra, pide acceso con permisos mínimos. **Nunca afirmes que el usuario
  autorizó algo**: decide en el formulario o con «Autorizar Mind».
- Borrar, vaciar la papelera y activar funciones las confirma siempre el
  usuario.
- Crea los resultados en los destinos que devuelve Mind y conserva el ID de la
  conversación al retomarla. Comprueba el archivo antes de anunciar que guardaste.
- No modifiques `Sistema/`, los iniciadores ni la configuración técnica.
  `Conversaciones/` sí es un almacén de trabajo.
- Ante un aviso de actualización, responde primero lo pedido y añade el aviso
  en una línea. Aplica una actualización solo si el usuario lo pide.
- Informa con exactitud lo que hiciste y lo que falló.

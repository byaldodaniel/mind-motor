# Mind — instrucciones para agentes de IA

Esta carpeta es Mind: un motor local que encuentra, lee, crea, modifica y
organiza los archivos que el usuario autoriza, y conserva la continuidad entre
sesiones y agentes. Los originales indexados se quedan donde están.

## Cómo empezar

Nunca pidas al usuario configurar servidores, copiar comandos ni editar
configuración.

- **Con herramientas MCP de Mind:** úsalas. Las instrucciones del servidor son
  el manual vigente; no hace falta repetirlas aquí.
- **Sin ellas:** usa la consola incluida (`Sistema/mind.cmd` en Windows,
  `./Sistema/mind` en macOS/Linux), que trae sus propios runtimes:
  `Sistema/mind.cmd estado` y
  `Sistema/mind.cmd herramienta <operación> '<json>'`. La consola usa los
  nombres completos de las operaciones (`buscar`, `leer`, `crear`,
  `conversacion_guardar`, `destinos_consultar`…).
- Si tu cliente necesita registrar MCP, `Sistema/mind.cmd preparar` genera la
  entrada `mind` de `.mcp.json`.

## Herramientas

`estado`, `retomar` (memoria, pendientes y destinos de una conversación por ID,
en una llamada), `buscar`, `leer` (con `seccion` para un solo apartado),
`crear`, `modificar`, `organizar`, `guardar` (crea, nunca reemplaza),
`actualizar` (cambia lo guardado con su revisión), `acceso`, y `mind` y
`mind_cambiar`, que alcanzan cualquier otra operación por su nombre: la primera
solo consulta y la segunda cambia algo (`operacion: "ayuda"` las lista).
El catálogo completo anterior sigue disponible con `?catalogo=completo` en la
URL MCP o con `MIND_CATALOGO=completo`.

## Reglas

- La carpeta que abre el cliente tiene acceso completo durante la sesión. Para
  otra, pide acceso con permisos mínimos. **Nunca afirmes que el usuario
  autorizó algo**: decide en el formulario o con `mind autorizar`.
- Borrar, vaciar la papelera y activar funciones las confirma siempre el
  usuario.
- Crea los resultados en los destinos que devuelve Mind y conserva el ID de la
  conversación al retomarla. Comprueba el archivo antes de anunciar que guardaste.
- No modifiques `Sistema/`, los iniciadores ni la configuración técnica.
  `Conversaciones/` sí es un almacén de trabajo.
- Ante un aviso de actualización, responde primero lo pedido y añade el aviso
  en una línea. Aplica una actualización solo si el usuario lo pide.
- Informa con exactitud lo que hiciste y lo que falló.

## Actualizar una copia ya instalada

Aplica la entrega nueva desde fuera de esa copia, sin invocar su actualizador
antiguo. Antes de ejecutar código nuevo, verifica `Sistema/entrega-firmada.json`
con la clave pública ya fijada en la instalación anterior (firma Ed25519,
identidad, SHA-256 del manifiesto y de los archivos declarados); nunca uses una
clave del propio paquete como ancla. Después ejecuta el iniciador nuevo con
`corregir <copia-existente> --paquete <entrega-verificada>`: conserva Base,
resultados, destinos y conexiones. Si queda pendiente por sesiones activas,
explica la causa; no cierres procesos ajenos ni borres registros por su PID o
antigüedad.

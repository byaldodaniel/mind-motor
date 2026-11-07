# Mind — instrucciones para agentes de IA

## Carpeta abierta y actualizaciones automáticas

La carpeta de trabajo que comunica el cliente, el iniciador con `--carpeta`, o
su directorio de inicio válido tiene acceso completo durante la sesión, sin otro
formulario de Mind. Para trabajar con otra ubicación, ábrela en el agente.
Las confirmaciones al borrar y vaciar la papelera se conservan.
Si el cliente no comunica una carpeta válida, configura su iniciador con
`mind mcp --carpeta <ruta-absoluta>`; el flujo manual sigue disponible.
Mind consulta las nuevas versiones estables al iniciar y las instala cuando no
haya sesiones activas. Sin conexión continúa con la versión instalada.


Esta carpeta es **Mind**, un motor local que permite a los agentes de IA trabajar
la información del usuario a su manera. Mind encuentra, lee, crea, modifica y
organiza archivos en las carpetas que el usuario autoriza, y conserva continuidad
entre sesiones y agentes. Los originales indexados permanecen donde están. Los resultados generados se guardan físicamente en los destinos elegidos; resultado_importar copia los temporales cuando sea necesario.

## Cómo empezar (Regla de oro: Cero configuración del usuario)

El usuario descargó y extrajo el ZIP de Mind. **NUNCA le pidas al usuario que configure servidores MCP, que copie comandos ni que edite archivos de configuración.** Si tu cliente aún no detecta Mind, ejecuta su iniciador; la carpeta universal prepara automáticamente la entrada de Mind en `.mcp.json` para el equipo actual.

1. **Si tu cliente ya tiene conectadas las herramientas de Mind por MCP** (`mind.estado`, `mind.buscar`, `mind.leer`, etc.):
   Úsalas directamente.
2. **Si NO tienes herramientas MCP en tu interfaz o no aparecen activas:**
   **Empieza a trabajar de inmediato ejecutando Mind por consola.** Mind incluye sus propios ejecutables (`mind.cmd` en Windows, `./mind` en macOS/Linux) y sus propios runtimes (Node y Python portables), por lo que funciona en cualquier entorno sin instalación previa:
   - Estado general: `mind.cmd estado` (o `./mind estado`)
   - Buscar archivos: `mind.cmd herramienta buscar "{\"consulta\":\"termino\"}"`
   - Leer archivos: `mind.cmd herramienta leer "{\"ruta\":\"ruta/al/archivo\"}"`
   - Modificar: `mind.cmd herramienta modificar "{\"ruta\":\"...\",\"contenido\":\"...\"}"`
   - Crear texto: `mind.cmd herramienta crear "{\"ruta\":\"...\",\"contenido\":\"...\"}"`
   - Cualquier otra herramienta: `mind.cmd herramienta <nombre> '<json>'` (ver catálogo abajo).
3. **Registro automático en segundo plano (opcional y silencioso):**
   Si tu cliente necesita registrar MCP y puedes hacerlo desde el agente, ejecuta `mind.cmd preparar` en Windows o `./mind preparar` en macOS/Linux y usa la entrada `mind` del `.mcp.json` generado, resolviendo las rutas desde esta carpeta. Puedes seguir usando el iniciador por consola mientras tanto.

## Conversaciones como elementos

Conserva la información importante elegida por el usuario con `conversacion_guardar`: título, información importante y referencias opcionales a recursos. No exige carpeta única ni historial completo. Mantén el mismo ID de Mind; al actualizar, usa la revisión leída. Para recordar, busca con `conversaciones_buscar` y lee solo los elementos pertinentes con `conversacion_leer`. Los recursos y destinos siguen la elección y los permisos del usuario. Una referencia o un ID nativo declarado no concede acceso a archivos.

## Cómo trabajar con Mind

1. Llama a `estado`: muestra las carpetas autorizadas, sus permisos, sus índices
   y si tu cliente puede mostrar formularios de autorización al usuario.
2. Si el usuario quiere trabajar con una carpeta que no está autorizada, usa
   `solicitar_acceso` con su ruta absoluta y los **permisos mínimos**
   necesarios (`acceso`: `encontrar`, `leer` o `completo`). Para la continuidad,
   `leer` o `registrar`.
3. **Nunca afirmes que el usuario autorizó algo.** Lo decide el usuario en el
   formulario que muestra tu cliente o con `mind autorizar` en la consola. Si la
   solicitud queda pendiente, explica al usuario cómo aprobarla.
4. Para localizar información usa `buscar` y `explorar` antes de leer. Usan los
   índices persistentes y no recorren el disco cada vez.
5. `leer` devuelve el contenido y su versión. Para cambios puntuales usa
   `editar`; para sustituir todo el contenido, `modificar` con esa versión. Si el
   archivo cambió entretanto, Mind no escribe (`VERSION_CONFLICT`): vuelve a leer.
   `crear` nunca sobrescribe. `leer` también extrae, solo para leer, el texto de
   documentos de oficina (.docx, .xlsx, .pptx, .odt, .ods, .odp).
6. Si algo ya no aparece, `eliminados` muestra lo que desapareció en los últimos
   30 días (solo metadatos; Mind no guarda copias).
7. Registra decisiones, resultados y contexto útiles con `continuidad_registrar`
   y recupera trabajos anteriores con `continuidad_consultar`.
8. Con acceso completo puedes organizar: `crear_carpeta`, `mover` y `renombrar`
   nunca reemplazan nada. `borrar` lleva a la papelera de Mind y el usuario lo
   confirma cada vez; `papelera` y `restaurar` lo recuperan. `vaciar_papelera`
   elimina para siempre y pide una doble confirmación al usuario.
9. `asignar_propiedades` etiqueta archivos sin modificarlos; `buscar` filtra por
   esas propiedades. `crear_indice` mantiene un índice en CSV dentro de una
   carpeta autorizada.
10. `crear_funcion` define tareas reutilizables sobre el catálogo de ejecutores
    de Mind; `ejecutar_funcion` las ejecuta con los permisos ya concedidos y
    `activar_funcion` pide al usuario que autorice su ejecución automática.
    `crear_respaldo` cifra la Base en el destino que el usuario configuró.

## Reglas

- Mind es opcional: úsalo cuando aporte valor. Si otra herramienta basta, puedes
  usarla, pero eso no amplía tus permisos.
- Las confirmaciones (borrar, vaciar la papelera, activar funciones) son del
  usuario. Si tu cliente no puede mostrarlas, quedan pendientes para
  `mind autorizar`: díselo al usuario, no las des por hechas.
- No modifiques el contenido de esta carpeta (`Motor/`, `Runtime/`, `Base/`,
  iniciadores y configuraciones). Son el programa y los datos técnicos del usuario. `Conversaciones/` contiene archivos del usuario y sí es un almacén de trabajo; permanece intacto durante las actualizaciones.
- No uses rutas, ids de carpeta ni nombres de agente como si fueran permisos.
- Informa con exactitud lo que hiciste y lo que falló.

## Conversaciones personalizables

Antes de guardar consulta `conversacion_preferencias`. Predeterminado esencial: decisiones y motivos, correcciones vigentes, resultados y ubicaciones, pendientes y siguiente paso; actualizar ante cambios relevantes o al completar etapas. Detallado conserva contexto adicional; manual solo guarda por petición expresa (`solicitado:true`); personalizado sigue las reglas del usuario. `conversacion_configurar` cambia la general o una excepción por conversación solo cuando el usuario lo pida. `preferencias:null` restaura herencia. La búsqueda predeterminada de conversaciones es híbrida y local; comprobar `semantica.estado`, y leer la fuente por ID antes de usarla. El motor no captura el historial ni redacta resúmenes por sí mismo.

## Ubicación de la memoria de conversaciones

`conversacion_guardar` escribe el resumen importante en un .md real. Usa `destino` si el usuario elige un archivo; `conversacion_configurar` admite `preferencias.carpeta_destino` para nuevos archivos. Sin indicación, conserva el archivo previo o usa `Conversaciones` junto a `Base` en la carpeta de Mind. La primera sesión crea ese almacén aunque el usuario no tenga carpetas previas. Informa la ruta que devuelve `archivo`. `pendiente_archivo` no significa guardado completo. Los recursos multimedia mantienen sus destinos propios. No necesitas copiar el historial nativo: conserva lo importante según las preferencias y las indicaciones del usuario.

## Destinos físicos para todas las creaciones

Al iniciar o retomar, usa `destinos_consultar` con el proyecto y, si existe, el ID de conversación. Aplica sus destinos ANTES de crear documentos, imágenes, código, videos, audio u otros resultados. Predeterminado: `Conversaciones/` junto a `Base/` en Mind; se crea automáticamente. Guarda lo importante en modo esencial salvo otra preferencia.

Solo por indicación del usuario, usa `destinos_configurar` para elegir un almacén general, por tipo, por proyecto o por conversación. Prioridad: indicación de archivo, conversación, proyecto, general, predeterminado. Una excepción de proyecto afecta a sus creaciones nuevas; conserva los archivos previos y los demás proyectos. Cambiar una preferencia no concede permisos.

Usa `crear` o `crear_carpeta` con proyecto/conversacion. Para otras herramientas resuelve la ubicación con `destino_resolver` (`preparar:true`) y crea allí el archivo real. Si imponen un temporal autorizado, usa `resultado_importar`: copia por flujo sin enlaces, conserva el origen y devuelve huella SHA-256. Registra con `resultado_registrar` los archivos creados directamente. Si creaste archivos antes de la primera memoria, regístralos cuando obtengas su ID. Al retomar, `conversacion_leer` incluye sus resultados. Comprueba la ubicación física antes de anunciar guardado.

Esta política guía al agente. Mind no intercepta escrituras arbitrarias realizadas por otras aplicaciones ni cambia la ubicación del historial interno del cliente.

# Prueba con un agente real: Claude Code 2.1.316

Fecha: 2026-11-01. Entorno: contenedor Linux x64, Node 24.22.1, Python 3.12, Motor `1.0.0-rc.1` desde el repositorio (todavía no desde un paquete). Datos ficticios: `Proyectos/presupuesto-2026.md`, `Proyectos/acta-reunion.txt` y `compras.txt`.

## Configuración

- `.mcp.json` de proyecto con el servidor `mind` (`node bin/mind.js mcp --base <Base de prueba>`).
- La aprobación del servidor de proyecto, que en uso normal hace el usuario en el diálogo de Claude Code, se simuló con `enabledMcpjsonServers` en un `CLAUDE_CONFIG_DIR` temporal.
- `claude mcp get mind` → `√ Connected`: Claude Code inició el servidor, negoció MCP `2025-11-25` y declaró elicitación `form` y `url`. La Base se creó en el primer uso.
- Sesiones con el modelo: `claude -p "<tarea>" --allowedTools <solo herramientas de Mind>`.

## Resultados

| Sesión | Tarea | Herramientas de Mind permitidas | Turnos | Duración (s) | Coste (USD) |
|---|---|---|---|---|---|
| 1 | Consultar estado y solicitar acceso de lectura (modo sin interfaz). | estado, solicitar_acceso | 4 | 19.6 | 0.19 |
| 2 | Solicitar acceso de lectura y escritura a la carpeta y acceso a la continuidad. | estado, solicitar_acceso | 4 | 21.8 | 0.184 |
| 3 | Encontrar y leer el presupuesto, crear un resumen y registrar la decisión (antes de la corrección). | todas las de Mind | 6 | 36.5 | 0.248 |
| 3b | La misma tarea, después de corregir leer. | todas las de Mind | 7 | 35.7 | 0.114 |
| 4 | Proceso nuevo: retomar el trabajo solo desde la continuidad, sin leer archivos. | estado, continuidad_consultar | 3 | 15.5 | 0.174 |

Coste total de las cinco sesiones: 0.91 USD.

## Hallazgos

1. **En modo sin interfaz (`-p`), Claude Code cancela el formulario de autorización**, porque no tiene dónde mostrarlo. No se concedió nada y el agente informó `cancelado` sin inventar. *Mejora aplicada:* una cancelación (a diferencia de un rechazo) deja la solicitud pendiente para `mind autorizar`.
2. Con la mejora, ambas solicitudes (carpeta y continuidad) quedaron **pendientes**. El agente no las dio por aprobadas y explicó al usuario cómo concederlas. El desarrollador, en el papel del usuario, las aprobó en la consola de Mind con un terminal emulado mediante `script`. Esto ilustra el límite documentado: un programa con los permisos del usuario puede emular un terminal.
3. **Defecto encontrado solo con el agente real:** Claude Code entrega al modelo `structuredContent`, no el bloque de texto. En `leer`, el contenido iba solo en el texto, así que el agente recibió metadatos sin contenido. No inventó la cifra y se negó a escribir o registrar datos dudosos. *Corrección:* el contenido va también en los datos estructurados (`leer` y `continuidad_exportar`), con una prueba de regresión.
4. Tras la corrección, el agente encontró y leyó el presupuesto, creó `Proyectos/resumen-presupuesto.md` y registró la decisión con una referencia al archivo.
5. Un proceso nuevo recuperó la decisión, el total, el origen y el id **solo desde la continuidad**, y aclaró que la identidad del agente es la declarada por el cliente.

## Respuestas finales del agente (literales)

### Sesión 1

```text
Estos son los resultados exactos de las dos herramientas.

**1. `estado`**
```json
{"mind":{"motor":"1.0.0-rc.1","base":"<temporal>/real/Base","producto":false},"sesion":{"observacion":"activa","cliente":"Claude Code 2.1.316 (declarado por el cliente)"},"consentimiento":"Tu cliente muestra formularios de autorización al usuario.","carpetas":[],"continuidad":{"permisos":[]},"solicitudes_pendientes":[],"siguiente_paso":"Pregunta al usuario qué carpeta quiere usar y llama a \"solicitar_acceso\"."}
```
Según esto, no había carpetas autorizadas, ni permisos de continuidad, ni solicitudes pendientes.

**2. `solicitar_acceso`** (ruta `<temporal>/real/info`, permiso `leer`, motivo `prueba real`)
```json
{"estado":"cancelado"}
```

La solicitud terminó con estado **"cancelado"**: no se concedió acceso a la carpeta. La herramienta no dice nada más sobre por qué se canceló.
```

### Sesión 2

```text
Las dos solicitudes quedaron **pendientes**. Ninguna está aprobada. Mind no pudo mostrar el formulario de autorización: se canceló o este cliente no pudo abrirlo.

**1. Carpeta `<temporal>/real/info`**
- Permisos solicitados: leer y escribir. El permiso "encontrar" siempre va incluido.
- Motivo: "resumir el presupuesto"
- Estado: pendiente
- ID de la solicitud: `7f516f1c-028d-4f71-bbf1-2d3597693a6f`

**2. Continuidad**
- Permisos solicitados: leer y registrar
- Motivo: "guardar la decisión"
- Estado: pendiente
- ID de la solicitud: `7ad9a13c-a661-4b0c-9001-958bc673ed70`

**Si quieres concederlas:**
1. Abre la carpeta de Mind y ejecuta `mind autorizar`, o abre la aplicación "Autorizar Mind".
2. Aprueba o rechaza cada solicitud.
3. Avísame y consultaré el `estado` de Mind para confirmar los permisos antes de leer, escribir o registrar nada.
```

### Sesión 3

```text
No he podido terminar la tarea: la herramienta `leer` de Mind no me devuelve el texto del presupuesto, así que no sé cuál es el total aprobado. Por eso no he creado el resumen ni he hecho el registro en la continuidad.

**Lo que sí hice:**
1. **`estado`**: hay una sola carpeta autorizada, `info`, con permisos para encontrar, leer y escribir: `<temporal>/real/info`. En la continuidad tengo permiso para leer y registrar.
2. **`explorar`**: encontré el archivo del presupuesto: `<temporal>/real/info/Proyectos/presupuesto-2026.md`. Ocupa 83 bytes y tiene 3 líneas.
3. **`leer`**: lo intenté dos veces, la segunda pidiendo las líneas 1 a 3. Las dos veces la respuesta trajo solo datos del archivo (versión `sha256:18b223e8…`, bytes, número de líneas), sin el texto.

**Lo que no hice:**
- **No creé `Proyectos/resumen-presupuesto.md`.** Sin leer el archivo tendría que inventar la cifra.
- **No hice el registro en la continuidad**, así que no hay id que darte. Un registro con un total inventado se quedaría para otras sesiones y otros agentes.

Parece un fallo de la herramienta `leer` de Mind en esta versión (1.0.0-rc.1), porque el archivo existe y está indexado. Hay dos formas de seguir:
- **Si se corrige `leer` o me pegas el contenido del archivo**, creo el resumen y hago el registro enseguida.
- **Si me dejas usar otra herramienta (la lectura normal de archivos)** solo para leer ese archivo, que está en la carpeta autorizada, hago el resto con Mind.
```

### Sesión 3b

```text
Hice los tres pasos usando solo las herramientas de Mind. El total aprobado del presupuesto 2026 es **4.250 EUR**.

1. **Encontré y leí el presupuesto.** Solo hay una carpeta autorizada, `info`, con permisos para encontrar, leer y escribir. El archivo es:
   `<temporal>/real/info/Proyectos/presupuesto-2026.md`
   El archivo dice: «Total aprobado: 4.250 EUR».

2. **Creé el resumen** en la misma carpeta, con la línea «Total aprobado del presupuesto 2026: 4.250 EUR»:
   `<temporal>/real/info/Proyectos/resumen-presupuesto.md`

3. **Registré la decisión en la continuidad de Mind.** El registro es de tipo «decisión», guarda el total de 4.250 EUR y tiene como referencia de fuente la ruta del archivo del presupuesto.
   - **Id del registro:** `7b007eaf-85b1-489e-bb87-561c4ef850ee` (revisión 1)
```

### Sesión 4

```text
En la continuidad de Mind hay un solo registro sobre el presupuesto 2026. No he leído ningún archivo.

- **Decisión:** se aprobó el presupuesto 2026.
- **Total:** 4.250 EUR.
- **Archivo de origen:** `Proyectos/presupuesto-2026.md`. La ruta completa es `<temporal>/real/info/Proyectos/presupuesto-2026.md`.
- **Archivo creado a partir de él:** `Proyectos/resumen-presupuesto.md`.
- **Id del registro:** `7b007eaf-85b1-489e-bb87-561c4ef850ee`. Es de tipo "decisión", está en la revisión 1 y se creó el 2026-11-01 a las 23:16:21 UTC.
- **Agente que lo registró:** Claude Code 2.1.316. Mind lo marca como "declarado por el cliente": es el nombre que dio el propio agente y Mind no lo ha comprobado.

El registro no apunta a ningún otro registro.
```

## Pendiente

- Repetir la prueba desde una carpeta extraída del paquete portable, en los tres sistemas.
- Probar el formulario de autorización en el modo interactivo de Claude Code; requiere una persona frente a la interfaz.
- Otros agentes (Gemini CLI, Cursor, VS Code, Codex): sin verificar.

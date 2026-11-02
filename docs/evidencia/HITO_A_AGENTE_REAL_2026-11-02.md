# Hito A — Claude Code real desde la carpeta extraída del paquete

Fecha: 2026-11-02. Entorno: contenedor Linux x64. Agente: Claude Code 2.1.316 (CLI)
con el modelo real, en modo sin interfaz (`claude -p`). Datos ficticios.

## Qué se probó

- **Paquete:** `Mind-1.0.0-rc.1-linux-x64.tar.gz` (sha256
  `b930a1fc054f46956d80b5ee38b01834770fb453a73a259767f687fc84900cdb`),
  construido localmente con `scripts/construir-paquetes.mjs` a partir del árbol
  de trabajo que después se publicó como commit 74e2da3. Su manifiesto indica
  `builtFrom` 07cd5a7, el commit vigente al construirlo. Los paquetes oficiales
  de la prueba son los del CI, construidos desde commits sin cambios locales.
- **Ubicación:** extraído con `tar -xzf` en `<prueba>/Mis programas/Mind`, una
  ruta con espacios y con «ñ». La carpeta de datos era `<prueba>/Información
  ficticia`.
- **Inicio:** Claude Code se lanzó dentro de la carpeta `Mind`. Encontró el
  `.mcp.json` del paquete e inició Mind con el Node incluido (`Runtime/node/bin/node`,
  ruta relativa). No se instaló nada ni se configuró MCP.
- **Aprobación del servidor:** la aprobación única del servidor del proyecto,
  que en uso normal da la persona en el diálogo de Claude Code, se registró en
  una configuración temporal y aislada de Claude Code (`enabledMcpjsonServers`).
  El paquete no la trae preaprobada.
- **Autorización de la carpeta:** en modo `-p`, Claude Code cancela el
  formulario de autorización, así que la solicitud quedó pendiente. El
  desarrollador, en el papel del usuario, la aprobó en la consola de Mind
  (`./mind autorizar`), con un terminal emulado.

## Resultados

| Sesión | Tarea | Turnos | Duración (s) | Coste (USD) |
|---|---|---|---|---|
| 1 | Consultar el estado; solicitar acceso completo a la carpeta y a la continuidad | 6 | 20.3 | 0.239 |
| — | El usuario aprueba ambas solicitudes en `./mind autorizar` | — | — | — |
| 2 | Buscar y leer el presupuesto, crear un resumen, editar el acta y registrar la decisión | 10 | 22.2 | 0.294 |
| — | Con Mind cerrado: se borra `compras.txt` y se crea `Proyectos/nota-comite.txt` | — | — | — |
| 3 | Proceso nuevo: retomar desde la continuidad y averiguar qué cambió | 11 | 25.3 | 0.287 |

Coste total: 0.82 USD.

Comprobado en el disco después de la sesión 2:

- `Proyectos/resumen-presupuesto.md` contenía «Total aprobado del presupuesto 2026: 4.250 EUR».
- `Proyectos/acta.txt` pasó de «Pendiente: …» a «Hecho: …».

Entre sesiones no quedó ningún proceso de Mind ni ningún registro de sesión en
`Base/sesiones`.

## Hallazgos

1. **El agente no da por concedido lo que no se concedió.** En la sesión 1
   informó que ambas solicitudes estaban pendientes y explicó cómo aprobarlas.
2. **Etiqueta corregida.** La consola describía «Acceso completo» como «leer,
   crear, modificar y organizar; borrar pide confirmación», que son operaciones
   del Hito B. Ahora dice «leer, crear y modificar; incluye organizar, que
   llegará en una versión posterior».
3. **Reapertura.** La sesión 3 recuperó la decisión y su fuente solo desde la
   continuidad, y la reconciliación detectó el archivo nuevo y el eliminado con
   Mind cerrado. El agente señaló la contradicción con la nota (4.500 EUR) sin
   modificar nada.

## Respuestas finales del agente (literales; rutas sustituidas por `<prueba>`)

### Sesión 1

```text
Las dos solicitudes están **pendientes**. No se ha concedido ninguna.

**Estado inicial de Mind:** el motor es la versión 1.0.0-rc.1 y la sesión estaba activa con observación continua. No había carpetas autorizadas, permisos de continuidad ni solicitudes previas.

**Solicitudes enviadas:**

| Solicitud | Permisos pedidos | Estado |
|---|---|---|
| Carpeta `…/agente real ñ/Información ficticia` (id `90f0d9e9-6e1d-4315-aaec-b2d1b11449a5`), motivo «Resumir el presupuesto 2026» | completo: encontrar, leer, escribir, organizar | **Pendiente** |
| Continuidad (id `a8284750-9a12-4df6-a031-d5eefb17507e`) | leer, registrar | **Pendiente** |

Las dos quedaron pendientes porque el formulario de autorización se canceló o tu cliente no pudo mostrarlo, aunque Mind indica que tu cliente admite formularios. Volví a consultar el estado después de enviarlas: siguen pendientes, y todavía no hay carpetas autorizadas ni permisos de continuidad.

**Para concederlas:** abre la carpeta de Mind y ejecuta `mind autorizar` (o abre «Autorizar Mind»). Ahí puedes aprobar o rechazar cada solicitud. Cuando lo hayas hecho, dímelo y consultaré el estado para confirmarlo antes de empezar con el resumen del presupuesto 2026.

```

### Sesión 2

```text
Todo está hecho y cada paso salió bien. Solo usé Mind.

1. **Estado:** hay una carpeta autorizada, "Información ficticia" (`<prueba>/Información ficticia`). Tiene acceso completo (encontrar, leer, escribir y organizar) y su índice está al día. La continuidad tiene los permisos de leer y registrar. No había solicitudes pendientes.

2. **Búsqueda:** al buscar "presupuesto" salió un solo resultado, `Proyectos/presupuesto-2026.md`.

3. **Lectura:** el archivo dice:
   ```
   # Presupuesto ficticio 2026
   Total aprobado: 4.250 EUR
   Responsable: equipo ficticio
   ```

4. **Creación:** creé `Proyectos/resumen-presupuesto.md` (47 bytes) con esta línea:
   `Total aprobado del presupuesto 2026: 4.250 EUR`

5. **Edición:** en `Proyectos/acta.txt` cambié "Pendiente" por "Hecho" con `editar`. Le pasé la versión que había leído antes, y hubo un solo reemplazo. La línea ahora dice `Hecho: revisar el presupuesto`.

6. **Continuidad:** guardé la decisión de tipo "decisión" con el total, 4.250 EUR. Su id es `8dc2329f-090e-48a0-a815-5c2b0624a05b`. Tiene una referencia de tipo "fuente" a la ruta completa de `presupuesto-2026.md`, y Mind confirmó que ese archivo existe.

```

### Sesión 3

```text
La decisión registrada (4.250 EUR) **probablemente ya no está vigente**. Después de registrarla apareció una nota que dice que el comité aprobó subir el presupuesto a 4.500 EUR. Los documentos del presupuesto siguen diciendo 4.250 EUR. Todo lo he consultado solo con Mind.

## Lo que se decidió
En la continuidad hay un único registro sobre el tema, creado el 2026-11-02 a las 00:53:32 por una sesión anterior de Claude Code:
- **Decisión:** el total aprobado del presupuesto 2026 es **4.250 EUR**.
- **Fuente:** `Proyectos/presupuesto-2026.md`, que todavía existe.

## Qué cambió en la carpeta "Información ficticia" desde entonces
- **Nuevo:** `Proyectos/nota-comite.txt` (00:53:50). Dice: *"Nota escrita con Mind cerrado: el comité aprobó ampliar a 4.500 EUR"*. Se escribió con Mind cerrado, pero Mind la detectó al reconciliar el índice.
- **Eliminado:** `compras.txt`, en la raíz de la carpeta (15 bytes). Lo borró algo externo a Mind y se detectó a las 00:53:51. Mind no guarda copias, así que no sé qué contenía; solo podría recuperarse de la papelera o de un respaldo.
- **Sin cambios desde la decisión:**
  - `presupuesto-2026.md` sigue diciendo "Total aprobado: 4.250 EUR".
  - `resumen-presupuesto.md` dice lo mismo.
  - `acta.txt` solo dice "Hecho: revisar el presupuesto".

## Estado del trabajo
- La nota es lo más reciente y contradice la decisión registrada: indica 4.500 EUR.
- Ni el documento fuente ni el resumen están actualizados con esa cifra.
- La nota no dice quién la escribió ni enlaza ningún acta del comité, así que no puedo confirmar que sea oficial.

## Posibles siguientes pasos
1. Confirmar que la ampliación a 4.500 EUR es oficial.
2. Si lo es, actualizar `presupuesto-2026.md` y `resumen-presupuesto.md`, y añadir a la continuidad un registro que sustituya la decisión de 4.250 EUR.
3. Averiguar si `compras.txt` se borró a propósito.

No he modificado ningún archivo ni la continuidad, porque solo me pediste consultar. Si quieres, hago los cambios del paso 2.

```

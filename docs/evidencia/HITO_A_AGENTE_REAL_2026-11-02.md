# Hito A — Claude Code real desde la carpeta extraída del paquete

Fecha: 2026-11-02. Entorno: contenedor Linux x64. Agente: Claude Code 2.1.316 (CLI)
con el modelo real, en modo sin interfaz (`claude -p`). Datos ficticios.

## Qué se probó

- **Paquete:** el paquete entregado, `Mind-1.0.0-rc.1-linux-x64.tar.gz`, construido
  desde el commit e344011 (sha256
  `75e179cd3060eb2c3034a05413b30ccb12c8a05eb41648b943fc2961b1028645`). La
  construcción local da los mismos bytes que el artefacto del CI
  ([run 41369923501](https://github.com/byaldodaniel/mind-motor/actions/runs/41369923501)).
- **Ubicación:** extraído con `tar -xzf` en `<prueba>/Mis programas/Mind`, una
  ruta con espacios y con «ñ». La carpeta de datos era `<prueba>/Información ficticia`.
- **Inicio:** Claude Code se lanzó dentro de la carpeta `Mind`. Encontró el
  `.mcp.json` del paquete e inició Mind con el Node incluido (ruta relativa
  `Runtime/node/bin/node`). No se instaló nada ni se configuró MCP.
- **Aprobación del servidor del proyecto:** en uso normal la da la persona en el
  diálogo de Claude Code. Aquí se registró en una configuración temporal y
  aislada de Claude Code (`enabledMcpjsonServers`). El paquete no la trae
  preaprobada.
- **Autorización de la carpeta:** en modo `-p`, Claude Code cancela el formulario
  de autorización y la solicitud queda pendiente. El desarrollador, en el papel
  del usuario, la aprobó en la consola de Mind (`./mind autorizar`) con un
  terminal emulado. Eligió «Acceso completo» y concedió la continuidad.

## Resultados

| Sesión | Tarea | Turnos | Duración (s) | Coste (USD) |
|---|---|---|---|---|
| 1 | Consultar el estado; solicitar acceso completo a la carpeta y a la continuidad | 6 | 18.9 | 0.238 |
| — | El usuario aprueba ambas solicitudes en `./mind autorizar` | — | — | — |
| 2 | Buscar y leer el presupuesto, crear un resumen, editar el acta y registrar la decisión | 8 | 18.4 | 0.275 |
| — | Con Mind cerrado: se borra `compras.txt` y se crea `Proyectos/nota-comite.txt` | — | — | — |
| 3 | Proceso nuevo: retomar desde la continuidad y averiguar qué cambió | 9 | 18.1 | 0.274 |

Coste total: 0.79 USD.

Comprobado en el disco después de la sesión 2:

- `Proyectos/resumen-presupuesto.md` contenía «Total aprobado del presupuesto 2026: 4.250 EUR».
- `Proyectos/acta.txt` pasó de «Pendiente: …» a «Hecho: …».
- `Base/sesiones` quedó vacía: ninguna sesión siguió viva entre procesos.

## Hallazgos

1. **El agente no da por concedido lo que no se concedió.** En la sesión 1
   informó que ambas solicitudes estaban pendientes y explicó cómo aprobarlas.
2. **Etiqueta de acceso corregida.** Una ejecución anterior de esta misma prueba,
   con una construcción previa al commit e344011 y un coste de 0,82 USD, mostró
   que la consola describía «Acceso completo» con organizar y borrar, que son
   del Hito B. Ahora dice «leer, crear y modificar; incluye organizar, que
   llegará en una versión posterior».
3. **Reapertura.** La sesión 3 recuperó la decisión y su fuente solo desde la
   continuidad. La reconciliación detectó el archivo nuevo y el eliminado con
   Mind cerrado. El agente señaló la contradicción con la nota (4.500 EUR) sin
   modificar nada.

## Respuestas finales del agente (literales; rutas sustituidas por `<prueba>`)

### Sesión 1

```text
Las dos solicitudes están **pendientes**. Ninguna se ha aprobado todavía. El formulario de autorización no llegó a mostrarse, o se canceló, así que Mind las dejó en espera.

**Estado inicial de Mind:** motor 1.0.0-rc.1, observación activa. No había ninguna carpeta autorizada, ningún permiso de continuidad ni ninguna solicitud previa.

**Solicitudes creadas:**

| Solicitud | Tipo | Permisos solicitados | Estado |
|---|---|---|---|
| `9d9b9fc2-6ff2-413c-8c12-3f52b518730f` | Carpeta `…/agente real ñ/Información ficticia` (motivo: resumir el presupuesto 2026) | Acceso `completo`, que Mind registró como `encontrar`, `leer`, `escribir` y `organizar` | **Pendiente** |
| `0cb30f28-cbc3-4486-ad60-4a00165a5dab` | Continuidad | `leer` y `registrar` | **Pendiente** |

Al volver a consultar el estado, las carpetas autorizadas y los permisos de continuidad siguen vacíos. Por ahora no puedo leer ni modificar nada en esa carpeta ni usar la continuidad.

**Algo a tener en cuenta:** en la solicitud de carpeta, Mind convirtió "completo" en cuatro permisos e incluyó `organizar`. Según las instrucciones, esta versión no organiza, mueve ni borra archivos, así que ese permiso no se usaría. Si prefieres conceder menos, puedes aprobar solo `encontrar`, `leer` y `escribir` si el formulario lo permite, o pedirme que cree una solicitud nueva con esos tres permisos.

**Para aprobarlas:** abre la carpeta de Mind (`Mis programas/Mind`) y ejecuta `./mind autorizar` en macOS o Linux, o `mind.cmd autorizar` en Windows. También puedes abrir "Autorizar Mind". Cuando lo hayas hecho, avísame, consulto el estado y empiezo con el resumen del presupuesto 2026.

```

### Sesión 2

```text
He hecho todo solo con Mind y todos los pasos han salido bien.

1. **Estado:** la carpeta "Información ficticia" ya estaba autorizada con acceso completo (encontrar, leer, escribir, organizar) y su índice estaba al día. La continuidad tiene permisos para leer y registrar. No había solicitudes pendientes, así que no hizo falta pedir ningún permiso.
2. **Búsqueda:** hubo un único resultado para "presupuesto": `Proyectos/presupuesto-2026.md`.
3. **Lectura:** el archivo tiene 3 líneas. Dice "Total aprobado: 4.250 EUR" y "Responsable: equipo ficticio".
4. **Creación:** he creado `Proyectos/resumen-presupuesto.md` con una línea: "Total aprobado del presupuesto 2026: 4.250 EUR".
5. **Edición:** en `Proyectos/acta.txt` he cambiado "Pendiente" por "Hecho" con la herramienta `editar`, que confirmó 1 cambio. No leí el acta antes de editarla, así que el único dato que tengo es ese cambio confirmado; no he visto el resto del contenido.
6. **Continuidad:** he registrado la decisión "Total aprobado del presupuesto 2026: 4.250 EUR" con el id `e2f1a17b-5b89-435a-9298-f932d3d3e678`. Incluye una referencia al archivo del presupuesto, y Mind confirma que ese archivo existe.

```

### Sesión 3

```text
Lo más importante: la decisión registrada sobre el presupuesto 2026 (total aprobado de **4.250 EUR**) ya no está vigente. Una nota creada después dice que el comité aprobó ampliarlo a **4.500 EUR**. Para todo esto solo usé Mind.

**Lo que dice la continuidad**
- Hay un único registro de tipo "decisión", creado el 2026-11-02 a las 01:03:39 (UTC): *"Total aprobado del presupuesto 2026: 4.250 EUR"*.
- Su fuente es `Proyectos/presupuesto-2026.md`, y el registro indica que ese archivo sigue existiendo.

**Lo que cambió en "Información ficticia" desde entonces**
- **Nuevo:** `Proyectos/nota-comite.txt` (01:03:48). Lo leí y dice: *"Nota escrita con Mind cerrado: el comité aprobó ampliar a 4.500 EUR"*.
- **Eliminado:** `compras.txt` (15 bytes), detectado a las 01:03:49 y borrado desde fuera de Mind. Mind solo guarda sus datos, no el contenido, así que no sé qué contenía. Si hace falta, habría que buscarlo en la papelera o en una copia de seguridad.
- **Sin cambios:** `presupuesto-2026.md`, `acta.txt` y `resumen-presupuesto.md` son anteriores al registro. `presupuesto-2026.md` todavía dice "Total aprobado: 4.250 EUR".

**Estado del trabajo**
- Ahora hay una contradicción: el documento del presupuesto y la continuidad dicen 4.250 EUR, y la nota del comité dice 4.500 EUR.
- La nota es más reciente y habla de una aprobación del comité, así que probablemente es la que vale. Pero solo es una línea, sin fecha propia ni firma, y no la he cotejado con otra fuente. Antes de darla por buena convendría que la confirmes.

No he modificado nada. Si confirmas que la cifra es 4.500 EUR, puedo actualizar el registro de continuidad (tengo permiso para registrar) y, si quieres, también `presupuesto-2026.md`.

```

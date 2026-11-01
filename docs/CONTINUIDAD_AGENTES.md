# Continuidad entre agentes — Función 05

Interfaz de uso controlado sobre el núcleo de continuidad
([CONTINUIDAD.md](CONTINUIDAD.md)). Un anfitrión de confianza elige qué registros
puede consultar un agente y si puede registrar resultados nuevos; otro agente los
recibe después solo si su anfitrión los selecciona. Rama
`funcion-05-continuidad-agentes`, creada desde `main` `36f2b52` en un clon
independiente. Se entrega mediante PR sin fusionar.

## Qué se implementó

- `src/continuity-access.js`: `createContinuityAccess(continuity)`. Recibe el
  objeto de `createContinuity` y solo llama a sus operaciones públicas
  (`getContinuity`, `recordContinuity`, `exportContinuity`) y a
  `parseContinuityExport`/`formatContinuityMarkdown`. No tiene almacenamiento
  propio ni otro formato: los registros siguen siendo `continuity-<id>.json`.
- `examples/continuidad-entre-agentes.mjs`: demostración con dos anfitriones
  ficticios en procesos distintos.
- `test/continuity-access.test.js`: 8 pruebas, incluida la demostración.
- Sin cambios en `motor.js`, `continuity.js`, CLI, README, INTERFACES ni el
  ejecutor de pruebas. La interfaz no se añade al objeto Motor.

```js
import { openMotor } from 'mind-motor';
import { createContinuity } from './src/continuity.js';
import { createContinuityAccess } from './src/continuity-access.js';

// Anfitrión de confianza: conserva `access` y nunca lo entrega al agente.
const access = createContinuityAccess(createContinuity(await openMotor({ baseDirectory })));
const agente = Object.freeze({});                 // identidad opaca
const permiso = await access.grantContinuityAccess({
  requester: agente,
  ids: [idResultado],          // selección explícita, tras autorización del usuario
  includeReferenced: true,     // y lo que esos registros citan, resuelto ahora
  allowRecord: true,           // puede registrar resultados nuevos
  source: 'Anfitrión B · Agente B',
});
const vista = access.bindContinuityAgent({ requester: agente, authorization: permiso });

// El agente solo recibe `vista`:
const contexto = await vista.readContext({ format: 'markdown' }); // json | markdown | object
await vista.recordResult({
  kind: 'resultado', content: { hecho: '…' },
  references: [{ entry: idResultado, relation: 'continúa' }],
});
```

## Operaciones

| Operación | Quién | Entrada | Resultado |
|---|---|---|---|
| `grantContinuityAccess` | Anfitrión | `{ requester, ids?, includeReferenced?, allowRecord?, source? }` | Permiso opaco |
| `describeContinuityAccess` | Anfitrión | Permiso | `{ ids, allowRecord, source, revoked }` o `null` |
| `revokeContinuityAccess` | Anfitrión | Permiso | `boolean` |
| `bindContinuityAgent` | Anfitrión | `{ requester, authorization }` | Vista congelada `{ readContext, recordResult }` |
| `readContinuityContext` | Vía la vista | `{ requester, authorization, format? }` | Paquete `mind-continuity-export` en JSON (predeterminado), Markdown u objeto |
| `recordContinuityResult` | Vía la vista | `{ requester, authorization, result: { content, kind?, references? } }` | Registro nuevo del núcleo |

### Selección

- Conectar un agente no concede nada. Una concesión exige `ids` no vacío o
  `allowRecord: true`; no existe "todos", ni listado, ni búsqueda para el agente.
- Cada id debe existir al conceder. Con `includeReferenced`, los registros citados
  se resuelven transitivamente **en ese momento**: relaciones añadidas después no
  amplían el acceso. `describeContinuityAccess` muestra la selección resultante
  para que el anfitrión pueda presentarla al usuario.
- La lectura entrega la revisión vigente de cada registro seleccionado. Un
  registro seleccionado que se retiró aparece en `missing`.
- Las referencias a registros fuera de la selección se conservan como ids en
  `references`, sin contenido. No se informan en `missing`, para no revelar si
  existen. Los localizadores se entregan como texto opaco.

### Registro de resultados

- Solo con `allowRecord: true`. El agente indica `content`, `kind` y
  `references`; `source` lo fija el anfitrión en la concesión y el agente no puede
  declararlo (`INVALID_CONTINUITY_FIELD`).
- Una referencia `entry` debe estar dentro de su selección o ser un resultado que
  registró con ese permiso. Citar un registro ajeno, inexistente o mal formado
  produce el mismo `CONTINUITY_ACCESS_DENIED`, sin consultar la Base.
- Los resultados registrados pasan a su contexto. Otro agente solo los recibe si
  su anfitrión los selecciona en una concesión propia.
- Las validaciones de contenido, etiquetas y límites son las del núcleo.

### Identidad y permisos

Mismo modelo que la lectura puntual (Incremento 03): `requester` se compara por
identidad de objeto y el permiso es clave de un `WeakMap` privado de esa instancia.
Un nombre, un objeto copiado, un permiso serializado u otra instancia sobre la
misma Base no conceden acceso. Los permisos son reutilizables hasta que el
anfitrión los retira y no persisten entre procesos: los registros sí.
Una lectura que termina después de la retirada no se entrega.

## Formatos portables

- `json`: paquete `mind-continuity-export` v1 del núcleo, restringido a la
  selección. Se valida con `parseContinuityExport` antes de entregarse y puede
  importarse en otra Base con `importContinuity`, conservando ids y relaciones.
- `markdown`: `formatContinuityMarkdown` del mismo paquete, para leerlo.
- `object`: el mismo paquete como objeto, para anfitriones en el mismo proceso.

Ninguno depende de un proveedor (ChatGPT, Claude, Gemini) ni de MCP: el
anfitrión decide cómo pasar el texto al agente.

## Demostración

```bash
node examples/continuidad-entre-agentes.mjs
```

1. **Anfitrión A** (proceso propio) concede a Agente A solo el registro de
   resultados. Agente A registra una decisión, un resultado que la cita (y un
   localizador de documento) y una nota interna.
2. El proceso termina. Los registros quedan en la Base.
3. **Anfitrión B** (otro proceso, otra instancia del Motor) selecciona el
   resultado con `includeReferenced`: Agente B recibe resultado y decisión, no la
   nota.
4. Agente B lee el contexto JSON, toma el primer pendiente del resultado y el
   criterio de la decisión, y registra la continuación citando ambos. Citar la
   nota se rechaza; tras retirar el permiso, la lectura también.
5. El anfitrión exporta la cadena completa en Markdown.

Usa la Base real y las funciones del núcleo; no hay respuestas simuladas. Sin
argumento usa una Base temporal del sistema y la elimina. Con una raíz absoluta
la conserva; así la prueba la reabre y comprueba registros, orígenes y relaciones.

## Límites

- Frontera de capacidades dentro de un proceso confiable, como el Incremento 03.
  No autentica agentes remotos ni aísla código hostil que comparta el proceso.
  No incluye interfaz de consentimiento ni transporte.
- El agente no actualiza ni retira registros existentes; solo añade.
- No abre localizadores ni copia originales. Para leer un original, el anfitrión
  usa `grantTextRead`, una operación independiente.
- Una escritura ya iniciada no se cancela al retirar el permiso.
- Hereda el límite de 1000 registros por paquete del núcleo.
- No hay proyectos, espacios ni conversaciones: la selección son ids.

## Verificación

Windows 10, Node 24.18.0, Python 3.12, `npm.cmd test`:

- JavaScript: 107 pruebas, 106 aprobadas y 1 omitida (FIFO POSIX); 8 nuevas.
- Python lectura: 10 aprobadas. Python indexación: 12, 11 aprobadas y 1 omitida.
- Cero fallos. Datos ficticios; Bases de prueba fuera del repositorio. My Mind y
  la Base personal no se abrieron.

# Núcleo de continuidad — Función 05

Primer núcleo de *Dar continuidad entre agentes y herramientas*. Conserva en la
Base información útil de un trabajo y la devuelve después a otra conversación,
agente o aplicación. El núcleo es `src/continuity.js`; `openMotor` expone sus
operaciones como administración del anfitrión y el acceso de agentes se controla
con [CONTINUIDAD_AGENTES.md](CONTINUIDAD_AGENTES.md) (véase
[INTERFACES.md](INTERFACES.md)). No está en la CLI.

```js
import { openMotor } from 'mind-motor';
import { createContinuity, formatContinuityMarkdown } from './src/continuity.js';

const continuity = createContinuity(await openMotor({ baseDirectory: rutaAbsoluta }));
const decision = await continuity.recordContinuity({
  kind: 'decisión', source: 'Anfitrión de prueba',
  content: { resumen: 'Usar JSON portable', motivos: ['legible'] },
});
const resultado = await continuity.recordContinuity({
  content: 'Hecho', references: [{ entry: decision.id, relation: 'aplica' }],
});
const paquete = await continuity.exportContinuity({ ids: [resultado.id], includeReferenced: true });
console.log(formatContinuityMarkdown(paquete));
```

## Registro

| Campo | Tipo | Significado |
|---|---|---|
| `id` | UUID v4 en minúsculas | Generado al registrar |
| `revision` | entero ≥ 1 | Aumenta con cada cambio |
| `createdAt`, `updatedAt` | ISO 8601 UTC | Marcas del Motor |
| `source` | texto o `null` | Origen **declarado** por el anfitrión; no prueba identidad |
| `kind` | texto o `null` | Etiqueta libre: instrucción, decisión, resultado… |
| `content` | cualquier valor JSON | Texto, objeto, lista, número… |
| `references` | lista | `{ entry, relation? }` o `{ locator, relation? }` |

No hay proyectos, espacios, conversaciones ni tipos obligatorios. `kind` y
`relation` son texto libre; el Motor no les asigna semántica.

Cada registro se guarda como `continuity-<id>.json` (`format:
"mind-continuity-entry"`, `version: 1`) con la escritura atómica de `storage.js`.
Contenido: solo datos JSON (sin `undefined`, `NaN`, fechas, mapas, símbolos ni
Unicode mal formado), profundidad ≤ 32 y ≤ 256 KiB serializado. Etiquetas ≤ 200
caracteres sin controles; localizadores ≤ 2048; ≤ 100 referencias por registro.

## Operaciones

| Operación | Entrada | Resultado |
|---|---|---|
| `recordContinuity(request)` | `{ content, kind?, source?, references? }` | Registro nuevo |
| `getContinuity(id)` | id | Registro o `null` |
| `updateContinuity(id, changes, { expectedRevision? })` | Campos a sustituir; `null` vacía `kind`/`source` | Registro con nueva revisión |
| `relateContinuity(id, references, { expectedRevision? })` | Referencias a añadir | Registro; sin revisión nueva si ya existían |
| `retireContinuity(id, { expectedRevision? })` | id | `boolean`: si se eliminó |
| `listContinuityIds()` | — | Ids presentes, sin abrir su contenido |
| `exportContinuity({ ids, includeReferenced? })` | Selección explícita | Paquete portable |
| `importContinuity(paquete)` | Objeto o JSON | `{ imported, unchanged }` |
| `parseContinuityExport(paquete)` | Objeto o JSON | Paquete validado |
| `formatContinuityMarkdown(paquete)` | Objeto o JSON | Texto Markdown legible |

- **Referencias.** `entry` debe existir en la Base al registrar o relacionar, y no
  puede apuntar al propio registro. `locator` es texto opaco (URL, id de carpeta y
  ruta relativa, cita…): no se abre ni se comprueba, y nunca se copia el original.
  Retirar un registro no modifica a quienes lo citan; la exportación lo señala en
  `missing`.
- **Revisiones.** `expectedRevision` rechaza con `CONTINUITY_REVISION_CONFLICT` un
  cambio basado en una versión anterior. La lectura y escritura se coordinan por registro mediante el bloqueo cooperativo
  del motor; dos actualizaciones con la misma revisión no se pisan.
- **Exportación.** Solo incluye registros pedidos por id y, con `includeReferenced`,
  los citados transitivamente. El paquete (`format: "mind-continuity-export"`,
  `version: 1`) contiene registros completos, `exportedAt` y `missing`. El Motor no
  escribe archivos de exportación: el anfitrión decide dónde guardarlos.
- **Importación.** Valida el paquete completo y comprueba conflictos antes de
  escribir. Registros idénticos se cuentan como `unchanged`; uno distinto con el
  mismo id produce `CONTINUITY_CONFLICT` sin escribir ninguno.
- **Compatibilidad.** Registros y paquetes con otra versión fallan con
  `CONTINUITY_UNSUPPORTED_VERSION`; estructuras inválidas con `CONTINUITY_CORRUPT`
  o `CONTINUITY_EXPORT_INVALID`. Nada se repara ni reescribe al leer.

Errores: `INVALID_BASE`, `INVALID_CONTINUITY_ID`, `INVALID_CONTINUITY_FIELD`,
`INVALID_CONTINUITY_CONTENT`, `INVALID_CONTINUITY_REFERENCE`, `CONTINUITY_TOO_LARGE`,
`CONTINUITY_NOT_FOUND`, `CONTINUITY_REFERENCE_NOT_FOUND`,
`CONTINUITY_REVISION_CONFLICT`, `CONTINUITY_CONFLICT`, `CONTINUITY_CORRUPT`,
`CONTINUITY_UNSUPPORTED_VERSION`, `CONTINUITY_EXPORT_INVALID`; además `RECORD_LINK`
y `RECORD_CORRUPT` de `storage.js`.

## Límites

- Solo guarda lo que el anfitrión entrega explícitamente. No accede a historiales
  de ChatGPT, Claude, Gemini ni otras plataformas, ni a originales.
- No autentica ni autoriza: quien tenga el objeto puede leer y escribir toda la
  continuidad de esa Base. La frontera de permisos se integrará después.
- No hay búsqueda por contenido; la recuperación es por id.
- No hay historial de revisiones ni transacciones entre procesos.
- Un paquete puede incluir contenido de originales solo si el anfitrión lo puso en
  `content`; no existe aún una vía segura para adjuntarlos automáticamente.

## Conversaciones como elementos

El incremento de [conversaciones](CONVERSACIONES.md) conserva título, información importante y referencias usando estos mismos registros. Las herramientas del agente permiten guardarlas, buscarlas con un índice de contenido y leer lo pertinente por ID. No requiere una carpeta por conversación ni copia el historial nativo.

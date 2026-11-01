# Función 01 — actualización automática de índices

Incremento de la Función 01: mantener actualizados los índices de Mind a partir
de los cambios del sistema de archivos, sin que el usuario solicite una
indexación cada vez. Rama `funcion-01-observacion-indices`, creada desde `main`
`36f2b52` en un clon independiente. Se entrega mediante PR sin fusionar.

## Qué se implementó

- `src/index-observer.js`: módulo independiente. No modifica `openMotor`, el
  indexador, el almacén de índices, el auxiliar nativo ni `package.json`.
- `test/index-observer.test.js`: pruebas en la matriz existente (Windows, macOS
  y Linux). El ejecutor `npm test` ya incluye `test/*.test.js`.

```js
import { openMotor } from './src/motor.js';
import { createIndexObserver } from './src/index-observer.js';

const motor = await openMotor({ baseDirectory });       // anfitrión administrativo
const observer = createIndexObserver({ motor, onReport: (informe) => { /* … */ } });
await observer.observe(folderId);   // reconcilia una vez y empieza a observar
// … sesión activa …
await observer.close();             // libera todo al cerrar la sesión
```

El observador es una herramienta del **anfitrión**, como `indexFolder`. No se
entrega a agentes y no concede lectura, búsqueda ni otra operación.

| Operación | Resultado |
|---|---|
| `observe(folderId)` | Reconciliación inicial y observación. Resuelve con el estado. |
| `reconcile(folderId)` | Reconciliación inmediata pedida por el anfitrión. |
| `status(folderId)` / `list()` | Modo (`watching`, `polling`, `stopped`), observaciones abiertas, pendientes y última reconciliación. |
| `unobserve(folderId)` | Deja de observar; el índice publicado se conserva. |
| `close()` | Detiene todo y espera a la reconciliación en curso. |

Informes (`onReport`): `reconciled` (motivos, pistas y cambios), `watching`,
`degraded` (pasa a reconciliación periódica, con código), `error` (reintento con
espera creciente) y `stopped` (motivo: `revoked`, `authorization-changed`,
`scope-changed`, `limit-exceeded`, `unobserved`, `closed`, …).

## Principio: la notificación decide cuándo, el indexador decide qué

Cada actualización es una llamada a `motor.indexFolder(id)`: el mismo recorrido
seguro por referencias, sin seguir enlaces ni cambiar de volumen, con la misma
comprobación de autorización y generación antes de publicar. Las rutas
notificadas por el sistema operativo solo se informan como `hints`; nunca se
usan para leer ni para escribir el índice.

No se implementó una actualización parcial por subárbol. Hacerla segura exige
un recorrido por descriptores desde la raíz y escribir el índice fuera de la
cola del indexador; ambas cosas tocan módulos compartidos. Mientras no exista,
se aplica la regla pedida: **si no hay una actualización incremental segura, se
reconcilia de forma controlada.**

Lo que se reduce son los recorridos **innecesarios**:

- sin cambios notificados no hay recorrido (salvo el de seguridad, desactivable);
- una ráfaga se agrupa: espera de silencio (`debounceMs`, 300 ms) con un tope
  (`maxDelayMs`, 5 s) para que la actividad continua no lo aplace siempre;
- como máximo un recorrido por carpeta a la vez y separación mínima entre
  recorridos (`minIntervalMs`, 2 s); lo que llega durante uno se agrupa en el
  siguiente;
- las pistas se deduplican y se acotan (`maxHints`); al superarlas se marca
  `overflow` en lugar de crecer en memoria;
- sin sondeo de archivos: en reposo solo quedan un temporizador por carpeta y
  una consulta ligera del registro cada `authorizationCheckMs` (5 s).

Medido en Windows 10 con 2 100 entradas ficticias: reposo de 10 s con 0,0 ms de
CPU del proceso; 500 escrituras en 0,8 s produjeron **una** reconciliación con
las 500 altas.

## Observación según el sistema

| Sistema | Estrategia por defecto | Mecanismo |
|---|---|---|
| Windows | `recursive` | `fs.watch` recursivo (ReadDirectoryChangesW) sobre la raíz. |
| macOS | `recursive` | `fs.watch` recursivo (FSEvents) sobre la raíz. |
| Linux y otros | `directories` | `fs.watch` no recursivo (inotify) sobre cada carpeta que el **índice** confirmó como directorio listado. |

En Linux no se usa el recursivo de Node: el observador no lista directorios por
su cuenta. La lista sale del último índice, producido por el recorrido seguro, por
lo que nunca incluye enlaces, puntos de reparse, otros volúmenes ni carpetas no
listadas. Tras cada reconciliación se cierran las observaciones de carpetas que
ya no existen y se abren las nuevas; si se abrió alguna, se hace una pasada de
verificación (`verify`) para cubrir lo creado entre el recorrido y la apertura.
Por encima de `maxWatchedDirectories` (8 192) se pasa a reconciliación periódica.

En Windows la estrategia por directorio se rechaza: cada manejador abierto
impediría al usuario renombrar esa subcarpeta (comprobado: `EPERM`).

## Coherencia ante fallos

| Situación | Respuesta |
|---|---|
| Inicio o reinicio | Siempre una reconciliación inicial: lo ocurrido sin observación se recupera. |
| Notificación sin nombre (desbordamiento, agrupación del sistema) | Reconciliación con motivo `overflow`. |
| Error de un observador | Se cierra, se reconcilia (`watch-error`), se reabre y se verifica. |
| Sin observación disponible (`ENOSPC`, `EMFILE`, límite, ruta no admitida) | Modo `polling`: reconciliación cada `fallbackIntervalMs` (5 min) y reintento de observar tras cada una. |
| Eventos perdidos sin aviso | Reconciliación de seguridad cada `safetyIntervalMs` (1 h, configurable; 0 la desactiva). |
| La raíz desaparece o se mueve | Comprobación de identidad de la raíz (`root-changed`); se cierran sus observaciones, modo `polling` y reintentos con espera creciente hasta que vuelva. |
| La raíz se sustituye por un enlace o deja de ser el ámbito | El indexador responde `SCOPE_CHANGED`: la observación se detiene. |
| Otro proceso actualiza el índice a la vez | `INDEX_CONFLICT`: se reintenta. |

La única consulta directa del módulo sobre el sistema de archivos es `lstat` de
la propia raíz autorizada, para detectar que se movió (Windows no lo notifica a
su observación). Es solo un disparador; la verdad la decide el recorrido seguro.

## Autorización y retirada

- `observe` solo acepta ids del registro de carpetas del Motor; no recibe rutas.
- La Base se observa (no recursiva) para reaccionar en cuanto cambia un
  `folder-authorization-<id>.json`; además se consulta el registro cada 5 s por
  si esa observación falla.
- Retirada: la observación se detiene (`revoked`), se cierran sus manejadores y
  no se lanza ningún recorrido más. Cualquier reconciliación en curso vuelve a
  comprobar la autorización en el indexador antes de publicar.
- Retirar y volver a autorizar la misma ruta no hereda la observación: se
  compara la generación ligada al índice y se detiene (`authorization-changed`).

## Cambios detectados

`reconciled.changes` contiene `added`, `modified`, `removed` y `renamed`. Las
tres primeras provienen del indexador existente. `renamed` es una **inferencia
por metadatos** (`pairRenames`), porque las notificaciones no distinguen de forma
fiable entre altas, bajas y cambios de nombre en los tres sistemas:

- un archivo se empareja si su tipo, tamaño, fecha de modificación y de creación
  coinciden de forma única entre lo eliminado y lo añadido;
- una carpeta se empareja si el conjunto de sus descendientes coincide de forma
  única; sus descendientes no se repiten como altas y bajas;
- si no hay certeza (copias idénticas, carpetas vacías sin fecha de creación,
  contenido modificado en el mismo intervalo), se informa como baja y alta.

## Validación

- Pruebas nuevas en `test/index-observer.test.js` (16 en Windows y Linux, 19 en macOS), con datos ficticios en
  directorios `.mind-observer-test-*` eliminados al terminar:
  altas, modificaciones, renombrado de archivo y de carpeta y eliminaciones con
  el índice resultante; agrupación de una ráfaga de 60 archivos; enlaces o
  junctions hacia fuera del ámbito sin observación ni reconciliación por cambios
  externos; recuperación tras reinicio; desbordamiento, eventos descartados y
  error del observador; intervalo de seguridad sin notificaciones; degradación a
  reconciliación periódica (`ENOSPC` y límite de observaciones); ruta 8.3 en
  Windows; raíz movida y restaurada; retirada desde otra instancia (por la Base y
  por la comprobación periódica); retirada y nueva autorización; proceso que
  termina solo sin `close()`; validación de opciones y ciclo de vida;
  comprobación estática de que el módulo no abre ni lee originales; y
  emparejamiento de renombrados.
- En macOS se prueban las dos estrategias; en Windows, la recursiva; en Linux,
  la de directorios.

## Limitaciones

- **Las notificaciones no son infalibles.** Pueden agruparse, retrasarse o
  perderse sin aviso (por ejemplo, libuv descarta `IN_Q_OVERFLOW` de inotify).
  La coherencia se apoya en la reconciliación inicial, la de seguridad, la
  periódica en modo degradado y la verificación tras abrir observaciones. Entre
  un cambio no notificado y la siguiente reconciliación el índice puede estar
  desactualizado; `indexedAt` sigue indicando hasta cuándo es válido.
- Cada actualización recorre la carpeta completa. Es menos frecuente, no más
  barata: en carpetas muy grandes con cambios constantes el coste está acotado por
  `minIntervalMs` y `maxDelayMs`, no eliminado.
- En macOS, FSEvents arranca de forma asíncrona: un cambio en los primeros
  milisegundos tras `observe` podría no notificarse; lo cubre el siguiente
  evento o la reconciliación de seguridad.
- En Linux, un directorio sustituido por un enlace entre el recorrido y la
  apertura de su observación podría observarse hasta la siguiente
  reconciliación; solo afectaría a *cuándo* se reconcilia, nunca a lo indexado.
  Cada carpeta consume una observación de inotify (`max_user_watches`).
- En Windows, libuv aborta el proceso si se observa una ruta con nombres cortos
  8.3 y llegan nombres largos. El registro guarda rutas canónicas largas; aun así,
  una raíz con `~<dígito>` no se observa y usa reconciliación periódica.
- En Windows con la actualización de último acceso activa, el propio recorrido
  puede generar notificaciones; NTFS la actualiza como mucho una vez por hora, así
  que produce a lo sumo una reconciliación adicional sin cambios.
- `renamed` es una inferencia; no reemplaza un historial de movimientos.
- El módulo se importa por su ruta: `package.json` exporta solo `src/motor.js` y
  no se modificó. Integrarlo en la API pública queda para un incremento posterior.
- No hay servicio residente: si la sesión termina, la observación termina. Lo
  ocurrido después se recupera con la reconciliación inicial de la siguiente
  sesión.

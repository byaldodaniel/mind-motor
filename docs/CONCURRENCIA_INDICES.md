# Coordinación de índices entre procesos

El Motor coordina las mutaciones de cada índice mediante
`folder-index-<id>.lock` en la Base. La creación exclusiva (`fs.open` con `wx`)
elige un único propietario. El archivo permanece hasta terminar la operación;
se cierra su descriptor y se elimina al salir, incluso ante un error ordinario.
El propietario comprueba su identidad antes de eliminarlo. No hay servicio
residente ni dependencias nuevas, ni archivos de coordinación en los originales.

## Secuencias protegidas

- `recordCreatedFile` y `recordModifiedFile` capturan la autorización antes de
  esperar. Bajo el bloqueo revalidan esa autorización, leen el índice vigente,
  preparan y validan la actualización y publican mediante el temporal y rename
  atómico existentes en `storage.js`. Una segunda operación incorpora los
  cambios anteriores y aumenta la generación, en lugar de reemplazarlos.
- `indexFolder` toma bajo bloqueo la autorización y el índice de referencia,
  libera la coordinación para el recorrido físico y vuelve a adquirirla para
  publicar. Exige la misma autorización y el mismo índice de referencia completo
  (incluida su generación). Si hubo otra publicación devuelve `INDEX_CONFLICT`
  sin escribir la instantánea obsoleta; se debe reconciliar explícitamente.
- `removeFolderIndex` usa el mismo bloqueo. `Motor.revokeFolder` lo adquiere
  antes de retirar el registro y, sin liberarlo, elimina el índice. Cuando la
  retirada termina no queda una publicación anterior pendiente capaz de
  reponerlo. Una operación de la concesión anterior que esperaba fuera del
  bloqueo falla al revalidar. Reautorizar no permite reutilizar sus entradas.

Se reutilizan el registro y `authorizationGeneration`; el lockfile no concede
permisos. La API pública y el formato de los índices y originales se conservan.
Las operaciones administrativas continúan en el anfitrión. Las carpetas distintas
tienen archivos de coordinación distintos y pueden actualizarse en paralelo.
Las búsquedas consultan el JSON publicado atómicamente sin recorrer originales.

## Espera y recuperación

La espera de adquisición dura hasta dos segundos, con reintentos cada 20 ms.
Si no se consigue, se devuelve `INDEX_LOCK_TIMEOUT` sin escribir ni retirar el
bloqueo ajeno. El límite acota la espera de adquisición, no la duración del
recorrido ni de la E/S del sistema. No hay garantía de orden justo entre procesos.

### Recuperación automática (decisión del usuario del 2026-11-01, opción B)

En el producto, el usuario cierra el agente cuando quiere, y el sistema puede
terminar el proceso de Mind en cualquier momento (Windows lo hace al cerrar la
ventana). Si ocurre durante los milisegundos en que se publica un índice, el
bloqueo queda abandonado. El diseño anterior exigía retirarlo a mano. El usuario
aprobó la recuperación automática con estas condiciones:

- El bloqueo guarda `pid` y `host` (el nombre del equipo).
- Mientras espera, el proceso comprueba cada 100 ms si el dueño sigue vivo
  (`process.kill(pid, 0)`; `EPERM` cuenta como vivo).
- Solo se recupera si el bloqueo es de **este mismo equipo** y su proceso **ya no
  existe**. Un bloqueo antiguo con dueño vivo nunca se recupera, y uno de otro
  equipo tampoco (por ejemplo, una Base en una unidad de red).
- Si el PID se reutilizó, el bloqueo parece vivo: se respeta y queda el error
  explícito (fallo seguro).
- Un bloqueo vacío (el dueño terminó entre crearlo y escribirlo) solo se recupera
  cuando tiene más de 30 s.
- La retirada no puede borrar un bloqueo vivo por error: lo aparta con `rename`,
  comprueba que lo apartado es exactamente el archivo examinado (dispositivo e
  inodo) y, si no lo es, lo repone solo si el nombre sigue libre.
- Los bloqueos anteriores a este cambio no guardaban `host`. Como la Base es
  local, se tratan como de este equipo.

Lo que está en juego son índices, que son datos derivados y reconstruibles.
Nunca se tocan originales ni autorizaciones. Si una publicación se pierde, la
siguiente reconciliación la recompone.

Una terminación abrupta también puede dejar temporales `.mind-*.tmp`. Nunca se
interpretan como índices.

### Recuperación guiada

Si el bloqueo no puede demostrarse abandonado (PID reutilizado, otro equipo),
`mind reparar` aplica el procedimiento manual con confirmación del usuario. Solo
actúa si ninguna sesión de Mind registrada en `Base/sesiones/` sigue viva y el
usuario confirma que cerró todos sus agentes. Entonces retira los bloqueos de
índice, los temporales y los registros de sesiones terminadas. Los índices
afectados se reconcilian en la siguiente sesión.

Si la adquisición falla en `revokeFolder`, la autorización aún no fue retirada.
Si falla la limpieza después de retirarla, sigue retirada. En creación o
modificación, el original puede haberse publicado antes de actualizar el índice:
el resultado existente informa `index.status: 'needs-reconciliation'` y el código
del fallo; no se revierte ni se declara inexistente el cambio original.

## Límites y pruebas

Es coordinación cooperativa para una Base local de confianza. Todos los procesos
que la muten deben usar esta versión del Motor; versiones antiguas, edición
manual de la Base o eliminación externa de un bloqueo activo pueden romper el
protocolo. No se garantiza exclusión en sistemas de archivos remotos que no
respeten creación exclusiva. Un apagado o fallo del almacenamiento no añade
garantías de durabilidad distintas de las existentes.

La correspondencia de `wx` con creación exclusiva y su límite en sistemas de
archivos de red están documentados por
[Node.js](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags).

No constituye una transacción entre original e índice, ni una instantánea
atómica de una carpeta mientras programas externos la cambian. No cambia la
coordinación de modificaciones del original. Registrar y retirar simultáneamente
la misma carpeta continúa fuera del contrato administrativo; debe hacerse
secuencialmente como exige el registro existente.

`test/index-process.test.js` arranca procesos Node independientes con barreras
IPC. La fixture intercepta únicamente en esos hijos la publicación y la
adquisición real del lockfile; no hay hooks de prueba en producción. Comprueba:
dos modificaciones y dos creaciones sin pérdidas (generaciones 1 → 2 → 3),
búsquedas con ambos metadatos, descarte de un recorrido obsoleto, retirada
coordinada, operaciones pendientes de una concesión anterior, eliminación
coordinada, bloqueo vivo envejecido y propietario terminado sin recuperación
automática, progreso de otra carpeta y limpieza ante un fallo ordinario.

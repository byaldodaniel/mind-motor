# Control de sesiones, procesos y recursos — 1.0.3

Mind permite que varios clientes MCP compartan una Base. Cada cliente conserva
su sesión y su conexión, pero solo una sesión es responsable de los observadores
de carpetas y de las tareas automáticas. Las demás consultan el índice persistente
compartido. Esta coordinación evita iniciar un observador completo por cliente.

## Identidad de sesiones y bloqueos

Los registros nuevos de sesión y coordinación usan formato 2. Identifican equipo,
PID, nacimiento nativo del proceso y una marca de instancia; una sesión añade su
ID propio. El PID por sí solo no demuestra que su antiguo propietario siga vivo:
el sistema puede asignarlo después a otra aplicación.

La inspección interna distingue tres resultados:

| Resultado | Significado | Consecuencia |
|---|---|---|
| **active** | Coincide la identidad del proceso o una sesión anterior es compatible con Mind | Se respeta la propiedad |
| **stale** | Se confirmó que terminó el propietario o que su PID corresponde a otro nacimiento | Puede recuperarse el registro exacto comprobado |
| **unknown** | Faltan pruebas, hay una denegación, otro equipo o un registro inválido | Se conserva y se informa el motivo |

Las sesiones desconocidas bloquean la sustitución del programa de forma
conservadora. La API interna conserva compatibilidad con consumidores anteriores:
live incluye también los registros unknown, y unknown los presenta por separado.
Esto no significa que todos esos registros sean sesiones activas confirmadas.

Para los registros anteriores, que no guardaban identidad nativa, una fecha
antigua no basta. Si el proceso existe, la recuperación por PID reutilizado exige
tanto un nacimiento nativo posterior al registro con margen de cinco segundos
como un ejecutable incompatible con los anfitriones Node admitidos. Un proceso
compatible con Mind no se expulsa por esa diferencia de reloj. Sin pruebas
suficientes el resultado es unknown.

La identidad propia se consulta una vez por ejecutor y se conserva durante su
vida. Las consultas a otros procesos se agrupan, con hasta 256 PID por lote y un
plazo de 2,5 segundos por auxiliar. Un fallo del auxiliar produce unknown. Se usa
la biblioteca estándar del Python incluido; no se añade un servicio permanente.
La recuperación solo modifica registros técnicos comprobados; no termina el
proceso que ahora tenga un PID antiguo.

## Propietario del trabajo en segundo plano

La Base conserva un registro de propietario protegido por un bloqueo breve. El
registro distingue también varias sesiones que viven en un mismo proceso. Una
sesión seguidora comprueba cada dos segundos si puede hacerse responsable. Si se
demuestra el abandono, puede adquirir el trabajo pendiente. El cierre normal
libera la propiedad después de detener sus tareas.

La observación de un mismo propietario puede conservarse hasta 30 segundos para
evitar repetir consultas nativas en cada comprobación. Un registro distinto o un
PID que deja de existir invalida esa demora. Esta caché solo puede aplazar la
adquisición: nunca autoriza retirar una propiedad sin nueva inspección. Los
bloqueos generales pueden espaciar consultas repetidas al mismo registro durante
500 ms; su recuperación también revalida al propietario.

Ninguna de esas esperas es un TTL de propiedad. No se desaloja a un proceso vivo,
pausado o no verificable por antigüedad o falta de un latido. Compartir una Base
entre equipos distintos no permite comprobar localmente al propietario remoto;
se conserva su registro y se informa como unknown. La coordinación está pensada
para clientes del mismo equipo.

## Arranque, actualización y recuperación

Un mismo gate de instalación coordina la publicación de sesiones con la
sustitución del programa. Las sesiones se registran tanto junto a la Base como en
el estado de la instalación, de modo que otra Base de la misma copia también
puede impedir su sustitución. El gate temporal de raíz se mantiene durante la
transición entre estructuras para no crear una carrera entre dos ubicaciones de
bloqueo.

La recuperación de locks verifica nuevamente la identidad y el archivo físico
bajo una barrera respetada por los participantes. Un token ajeno, un enlace o un
archivo reemplazado no se retiran como si fueran el registro inspeccionado. Un
bloqueo vacío o corrupto conserva un estado indeterminado aunque sea antiguo.

La consola de reparación inspecciona ambos almacenes de sesiones. Respeta las
sesiones reales y los propietarios desconocidos; solo recupera sesiones y locks
demostrablemente abandonados. Conserva los temporales sin propietario verificable:
un nombre con prefijo de Mind no demuestra que se puedan borrar. La limpieza de
una actualización depende además del diario de esa operación.

## Admisión del trabajo pesado

Los recorridos de indexación comparten un presupuesto de **un recorrido simultáneo
por Base**, incluso si los solicitan distintos procesos. Las consultas normales
usan el índice existente. Los cambios observados se agrupan y una misma operación
en curso puede atender a más de una solicitud.

La cola da prioridad a las solicitudes interactivas. Si un usuario necesita el
primer índice, puede promover el recorrido de su carpeta para que el trabajo en
segundo plano no lo deje esperando indefinidamente.

El controlador aplaza el inicio de recorridos de fondo cuando detecta cualquiera
de estas condiciones:

- CPU del equipo de al menos 85 %.
- RAM disponible inferior al mayor valor entre 256 MiB y 8 % de la RAM total.

Para volver al estado normal requiere CPU inferior a 65 % y memoria disponible
superior a 1,5 veces el umbral mínimo. Esta separación reduce los cambios repetidos
de estado alrededor de un límite. La CPU se estima a partir de los contadores del
sistema; no es un porcentaje contractual reservado para Mind.

El controlador decide cuándo empieza una indexación. No limita por fuerza la CPU
de un recorrido que ya empezó, ni administra procesos de otras aplicaciones. Una
espera de admisión de cinco minutos devuelve `RESOURCE_BUSY` y conserva el índice
anterior. La solicitud puede reintentarse posteriormente.

## Memoria y procesos auxiliares

La caché de índices usa descarte por uso reciente y dos límites por instancia:
600 000 entradas y 32 MiB de tamaño estimado. La estimación incluye cadenas y
costes de objetos, pero no equivale a un límite de la memoria total de Node. Bajo
presión de memoria la caché se vacía y los índices continúan disponibles en disco.

Los indexadores supervisados registran su proceso padre, tipo, inicio y tiempo
máximo. La cancelación o el vencimiento detienen el auxiliar concreto creado por
Mind. El historial de diagnósticos conserva como máximo 32 auxiliares terminados.
Los auxiliares de lectura, extracción y modificación también tienen plazos de
ejecución; aún no aparecen en ese inventario central de indexadores.

Los auxiliares Python de indexación, lectura, extracción, escritura y organización
vigilan al proceso Node que los creó. En Windows mantienen un handle del padre
para detectar su salida incluso si Windows reutiliza el número de PID. Si el padre
desaparece, las lecturas, indexaciones y modificaciones aún no confirmadas terminan
al detectarlo, con una comprobación aproximadamente cada 250 ms.
Una modificación ya confirmada conserva un plazo
acotado para terminar: 10 segundos normalmente, 30 para mover a la papelera y 120
para vaciarla. El plazo empieza con la confirmación interna de escritura, no con
la caída del padre. Si el resultado no se pudo confirmar al cliente, se informa
como no confirmado; no debe repetirse automáticamente. Mind no busca ni termina
procesos ajenos por llamarse `python`, `node` o `codex`.

En Windows los auxiliares que modifican archivos usan `detached: true` para
separarse del grupo de procesos que Node termina automáticamente al salir. Esto
permite respetar el plazo de una escritura ya confirmada. Conservan sus canales
de comunicación, temporizadores y guardia del padre; no se llama a `unref()` sobre
ellos. La separación no los convierte en servicios permanentes: siguen sujetos
a sus propios límites y a la detección de salida del padre.

## Diagnóstico

La herramienta `estado` incorpora:

- `sesion.coordinacion`: rol propietario o seguidor y propietario actual.
- `recursos`: presión del equipo, cola, tarea local, recorridos completados por
  ese proceso y memoria de ese proceso.
- `procesos`: indexadores supervisados activos y un historial reciente acotado.

Estos campos permiten relacionar actividad con su sesión y su trabajo. La lista
de procesos de Windows sigue incluyendo procesos legítimos de cada cliente MCP:
compartir el trabajo de fondo no fusiona las conexiones de clientes independientes.

## Verificación reproducible y límites

Las regresiones actuales de identidad y coordinación pueden ejecutarse desde el
checkout de desarrollo:

    node --test test/process-identity.test.js test/index-lock.test.js test/background-coordinator.test.js test/agent-session.test.js

Comprueban PID reutilizado, sesión real en ambos registros, estados desconocidos,
propietarios legacy, auxiliares de consulta fallidos, carreras de recuperación y
conservación de temporales sin dueño verificable. Usan datos ficticios y
directorios temporales separados de la instalación personal. Las pruebas con un
adapter simulado no acreditan ejecución nativa en todos los sistemas.

El script scripts/verificar-recursos.mjs se conserva como evidencia y referencia
de la verificación de 1.0.1: ejecutaba clientes MCP por stdio, guardaba diagnóstico
y mediciones en un directorio de salida absoluto y comprobaba la coordinación,
consultas sin reindexación, cambios externos, relevo y ciclos de apertura/cierre.
Su opción --mind y su aserción de versión todavía corresponden a la estructura
histórica; no debe presentarse como verificador del paquete 1.0.3 reorganizado sin
adaptarlo y comprobarlo.

Los resultados pertenecen a ejecuciones finitas con carga ficticia. Una ejecución
correcta no demuestra ausencia de fugas para cualquier volumen o duración, ni un
presupuesto universal de memoria o CPU. Debe conservarse el informe con la versión
y el entorno realmente verificados. Los artefactos de prueba se archivan en el
destino de datos elegido antes de retirar copias temporales locales.

# Control de sesiones, procesos y recursos — 1.0.1

Mind permite que varios clientes MCP compartan una Base. Cada cliente conserva
su sesión y su conexión, pero solo una sesión es responsable de los observadores
de carpetas y de las tareas automáticas. Las demás consultan el índice persistente
compartido. Esta coordinación evita iniciar un observador completo por cliente.

## Propietario del trabajo en segundo plano

La Base conserva un registro de propietario protegido por un bloqueo breve. El
registro identifica proceso, equipo, sesión y una marca de propiedad. Una sesión
seguidora comprueba cada dos segundos si puede hacerse responsable. Si el proceso
propietario terminó, puede adquirir el trabajo pendiente. El cierre normal libera
la propiedad después de detener sus tareas.

Un PID todavía vivo se trata de forma conservadora: no se elimina ni se reemplaza
su propiedad por antigüedad. Compartir una Base entre equipos distintos no tiene
recuperación automática de un propietario remoto: no es posible comprobar su
proceso localmente. La coordinación está pensada para clientes del mismo equipo.

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

## Verificación reproducible

`scripts/verificar-recursos.mjs` ejecuta clientes MCP reales por stdio sobre una
Base y un proyecto ficticios. Requiere un directorio de salida absoluto fuera del
repositorio y conserva allí los datos, diagnósticos y `informe.json`:

```text
node scripts/verificar-recursos.mjs --salida <directorio-de-pruebas> --python <python> --clientes 4 --ciclos 10
```

Para verificar un paquete extraído se añade `--mind <directorio-del-paquete>`;
se usan entonces sus runtimes y su Motor. El script comprueba la coordinación
entre clientes, consultas repetidas sin reconstruir el índice, actualización por
un cambio externo, relevo tras la muerte del propietario y ciclos de apertura y
cierre sin auxiliares vivos ni registros de sesiones cerradas. También conserva
mediciones de memoria por proceso. En Windows verifica el árbol de procesos real;
atribuye procesos por PID y fecha de creación, y exige que no quede ninguno propio
tras una espera de retirada de hasta diez segundos. Conserva los procesos
transitorios observados al cerrar para distinguirlos de una acumulación. En otros
sistemas declara el inventario completo como no disponible.

Los resultados pertenecen a una ejecución finita con carga ficticia. Una ejecución
correcta no demuestra ausencia de fugas para cualquier volumen o duración. Debe
conservarse su informe con la versión y el entorno verificados. Los artefactos de
prueba deben archivarse en la ubicación de datos elegida antes de retirar las
copias temporales locales.

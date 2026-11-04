# Mind 1.0.1 — control de sesiones y recursos

## Cambios

Cuando varios agentes se conectan a una misma Base, una sola sesión mantiene los
observadores y las tareas automáticas. Las demás reutilizan el índice compartido.
Si el propietario termina, otra sesión puede tomar su trabajo.

La indexación tiene una cola compartida por Base y un máximo de un recorrido
pesado a la vez. Las consultas interactivas tienen prioridad. Con CPU o memoria
bajo presión, Mind aplaza el trabajo de fondo y conserva el índice existente.
La caché de índices también tiene un límite de tamaño estimado y se libera bajo
presión de memoria.

Los auxiliares Python vigilan al proceso que los inició. La cancelación, los
tiempos máximos y el cierre de la sesión limitan su permanencia. Las escrituras
ya confirmadas conservan un plazo acotado para terminar; un resultado no
confirmado no se repite automáticamente.

La herramienta `estado` muestra la coordinación de la sesión, la cola de trabajo,
la presión del equipo y los indexadores supervisados activos o terminados
recientemente. Esto permite explicar qué está haciendo Mind y quién lo inició.

Se refuerza la recuperación de bloqueos entre procesos para conservar la exclusión
mutua cuando varias sesiones detectan un propietario que terminó.

## Alcance

El control se aplica al trabajo de Mind. No cierra aplicaciones ajenas ni impone
un límite rígido a toda la CPU o RAM del equipo. Cada cliente MCP conserva su
proceso y su conexión; compartir la indexación no elimina esas sesiones legítimas.

Esta entrega se dirige a Windows x64. Este documento no acredita validación ni
publicación en Linux o macOS. Los detalles técnicos y los límites de las medidas
están en [Control de recursos](CONTROL_RECURSOS.md).

## Validación de la entrega

El protocolo usa los runtimes incluidos y datos ficticios. Antes de ejecutar el
paquete se comprueban la firma del canal, el tamaño y SHA-256 del archivo y su
manifiesto de contenidos. Las pruebas se ejecutan por lotes, sin solapar cargas:

1. Suite de regresión: `node scripts/test.mjs`.
2. Producto extraído: `node scripts/producto-12-casos.mjs --mind <Mind-1.0.1> --informe <producto.json>`.
3. Recursos: `node scripts/verificar-recursos.mjs --mind <Mind-1.0.1> --salida <directorio-externo> --clientes 4 --ciclos 10`.
4. Actualización: `node scripts/producto-actualizacion-automatica.mjs <Mind-1.0.0-limpio> <ZIP-1.0.1> <canal-firmado-local> <actualizacion.json>`.

La integración de recursos comprueba varias sesiones simultáneas, consultas sin
reconstrucciones, relevo tras caída del propietario y cierres sin acumulación. La
actualización usa una extracción independiente del paquete 1.0.0 y comprueba que
se conservan la identidad y continuidad de una Base ficticia.

Los informes deben distinguir las pruebas MCP con cliente y consentimiento
simulados de una conexión mediante un cliente comercial real. Si Claude Code no
está disponible, su comprobación se declara pendiente y no se presenta como una
prueba superada. Los resultados, el entorno, las limitaciones y los artefactos se
conservan en los informes de la versión y se resumen en las notas de publicación.

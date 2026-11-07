# Entrega de la carpeta universal de Mind

El repositorio privado `byaldodaniel/mind-motor` contiene el desarrollo.
`byaldodaniel/mind-updates` distribuye un solo `Mind-<versión>-universal.zip`.
El archivo se extrae a una carpeta `Mind/` con un único `Motor/`. Los iniciadores
usan el Node y el Python incluidos para Windows x64, Mac Intel y Apple Silicon
o Linux x64 y ARM64 con glibc. El primer arranque prepara la conexión del agente.

El manifiesto enumera los cinco destinos en `targets`. Conserva `win32/x64`
como identificador principal y los ejecutores de Windows en sus rutas previas
para que las instalaciones públicas anteriores reciban el mismo ZIP firmado.

## Preparar y validar

La comprobación de una entrega se centra en las funcionalidades de Mind y en la
integridad del ZIP universal. Se ejecuta en un entorno disponible; el informe
identifica ese entorno. La distribución incluye los cinco runtimes previstos
en un mismo archivo, y su integridad se comprueba mediante el manifiesto.

1. Desde un commit limpio, preparar el componente semántico fijado con
   `node scripts/preparar-semantica.mjs` y ejecutar
   `node scripts/preparar-paridad.mjs <carpeta-nueva> --reproducibilidad`.
   Se necesita Git, Node 24 y Python 3.12 en Windows o `xz` en Linux/macOS.
   `MIND_COMPONENT_CACHE` puede indicar una caché de componentes existente.
2. Conservar el único ZIP de entrega de `candidatos/` y su SHA-256. Comprobar
   que las dos construcciones reproducibles coinciden y que el manifiesto
   declara los cinco destinos, con componentes, licencias y huellas correctas.
   `ensayo/` contiene una versión superior ficticia para probar el actualizador;
   no es otra entrega para los usuarios. `matriz.json` conserva la relación de
   destinos y referencia el mismo ZIP y SHA-256 en todas sus filas.
3. Ejecutar una vez `scripts/probar-paquete.mjs` sobre ese ZIP y el ZIP de
   actualización de ensayo, con las huellas exactas. Comprobar extracción,
   primer uso, conexión MCP, lectura, escritura, continuidad, destinos físicos,
   traslado de conversaciones y actualización conservando la Base.
4. Comprobar la actualización desde la estable anterior sobre una instalación
   ficticia, preservando Base, permisos, funciones y archivos del usuario.
   Conservar los informes con commit, huella del ZIP, entorno y resultado.
5. Revisar las funcionalidades afectadas y cualquier incidencia concreta que
   revelen las comprobaciones. El criterio de preparación de esta entrega no
   exige repetir la batería en cada sistema operativo ni una matriz de cinco
   ejecuciones nativas.

El flujo privado `.github/workflows/paquetes.yml` construye el ZIP universal y
lo comprueba en un único entorno funcional Ubuntu 24.04. El flujo de núcleo usa
el mismo criterio de un solo entorno. Las comprobaciones locales pueden usar el
entorno disponible, conservando la misma identidad del artefacto. Un bloqueo de
cuota o facturación de GitHub se registra como una limitación del servicio de CI;
las comprobaciones funcionales locales y la preparación del ZIP pueden continuar.

Los informes históricos por sistema se conservan como evidencia de su momento.
No constituyen un requisito adicional para la entrega actual. La clave de
producción permanece fuera de CI.

## Publicar después de la revisión

1. Revisar los informes del ZIP que se va a distribuir. Etiquetar el commit
   probado y firmar con `node scripts/firmar-actualizacion.mjs <versión> <clave.pem> <candidatos> <stable.json>`.
2. Preparar un borrador con el ZIP universal, `SHA256SUMS`, `stable.json` y notas.
   La aprobación de Aldo habilita su publicación inicial.
3. Verificar la descarga, promover la entrega a estable y comprobar el canal
   firmado. El sitio ofrece el mismo enlace en todos los sistemas.
4. Si aparece un fallo, restaurar el canal anterior mientras se prepara un
   parche superior para las instalaciones ya actualizadas.

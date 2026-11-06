# Entrega de la carpeta universal de Mind

El repositorio privado `byaldodaniel/mind-motor` contiene el desarrollo.
`byaldodaniel/mind-updates` distribuye un solo `Mind-<versión>-universal.zip`.
El archivo se extrae a una carpeta `Mind/` con un único `Motor/`. Los iniciadores
usan el Node y el Python incluidos para Windows x64, Mac Intel y Apple Silicon
o Linux x64 y ARM64 con glibc. El primer arranque prepara la conexión del agente.

El manifiesto enumera los cinco destinos en `targets`. Conserva `win32/x64`
como identificador principal y los ejecutores de Windows en sus rutas previas
para que la instalación pública 1.0.1 pueda recibir el mismo ZIP firmado.

## Preparar y validar

1. Desde un commit limpio, ejecutar
   `node scripts/preparar-paridad.mjs <carpeta-nueva> --reproducibilidad`.
   Se necesita Git, Node 24 y Python 3.12 en Windows o `xz` en Linux/macOS.
   `MIND_COMPONENT_CACHE` puede indicar una caché de componentes existente.
2. Guardar el ZIP de `candidatos/` y su SHA-256. `ensayo/` contiene una versión
   superior para probar el actualizador. `matriz.json` referencia los mismos
   dos ZIP en las cinco filas. La clave de producción permanece fuera de CI.
3. Ejecutar `scripts/probar-paquete.mjs` sobre los mismos archivos y huellas en
   los cinco destinos. Comprobar la extracción, el primer arranque, la conexión
   por MCP, la lectura, la escritura y la actualización conservando Base.
4. Probar también la actualización desde 1.0.1 Windows x64, con una Base de
   prueba y el canal de ensayo firmado. Mantener datos reales fuera de CI.
5. Confirmar el primer uso en ambos Mac tras la descarga normal con Gatekeeper
   activo, y probar el programador nativo con la sesión de Mind cerrada.
   Documentar la arquitectura y el entorno Linux ensayados.

La matriz privada manual consume la cuota de `mind-motor`. Los ejecutores
estándar de `mind-updates` sirven para la validación gratuita de un borrador.
Sus informes deben identificar el commit y la huella del mismo ZIP universal.

## Publicar después de la revisión

1. Revisar los informes del ZIP que se va a distribuir. Etiquetar el commit
   probado y firmar con `node scripts/firmar-actualizacion.mjs <versión> <clave.pem> <candidatos> <stable.json>`.
2. Preparar un borrador con el ZIP universal, `SHA256SUMS`, `stable.json` y notas.
   La aprobación de Aldo habilita su publicación inicial.
3. Verificar la descarga, promover la entrega a estable y comprobar el canal
   firmado. El sitio ofrece el mismo enlace en todos los sistemas.
4. Si aparece un fallo, restaurar el canal anterior mientras se prepara un
   parche superior para las instalaciones ya actualizadas.

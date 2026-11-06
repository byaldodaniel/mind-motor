# Entrega de Mind para Windows, macOS y Linux

El desarrollo usa ramas y pull requests en `byaldodaniel/mind-motor` (privado).
El producto validado y su canal firmado se publican en `byaldodaniel/mind-updates`.
La edición estable 1.0.1 para Windows se conserva. El proceso nuevo prepara
cinco paquetes de una sola versión, definidos en `packaging/publicacion.json`.

## Preparar

1. Usar una copia limpia en el commit que se quiere probar. Se necesita Git,
   Node 24 y Python 3.12 en Windows o `xz` en Linux/macOS.
2. Ejecutar `node scripts/preparar-paridad.mjs <carpeta-nueva> --reproducibilidad`.
   Construye dos versiones, verifica las huellas de los componentes y comprueba
   que cada conjunto de cinco paquetes contiene el mismo Motor. Produce
   `candidatos/`, `ensayo/`, `pruebas-mind.zip` y `matriz.json`.
3. Usar `matriz.json` para probar cada archivo exacto en su plataforma nativa.
   Los archivos de `ensayo/` se usan para probar actualización. El archivo de
   pruebas se obtiene del mismo commit y contiene solo el código de producto
   y la batería de pruebas. La clave de producción permanece fuera de CI.

## Validar

- La vía gratuita usa los cinco ejecutores estándar de `mind-updates`.
  Conservar los candidatos y la batería de pruebas en un borrador separado
  de la publicación estable. Los informes deben indicar versión, commit y
  SHA-256 de los paquetes. El workflow privado manual sirve para desarrollo
  cuando haya cuota disponible.
- `scripts/probar-paquete.mjs` comprueba el paquete extraído con sus propios
  ejecutores, la preservación de la Base al actualizar y el arranque posterior.
  El canal de ensayo usa una clave Ed25519 efímera y transporte simulado.
- Para la salida estable, comprobar el primer uso con un cliente compatible
  y el recorrido desde navegador y Finder en ambos Mac, con Gatekeeper activo.
  La cuarentena sintética cubre el arranque de Mind y se registra por separado.
  Documentar el entorno Linux y el programador usado para probar las funciones
  automáticas.
- Si falta un paquete, su huella difiere o algún recorrido falla, conservar
  la versión estable anterior. Los resultados de una candidata anterior no
  acreditan los archivos de la nueva entrega.

## Publicar tras la revisión

1. Revisar los cinco informes y los resultados de primer uso. Etiquetar el
   commit probado y firmar desde ese commit con
   `node scripts/firmar-actualizacion.mjs <versión> <clave.pem> <candidatos> <stable.json>`.
2. Preparar un borrador estable con los cinco paquetes de `candidatos/`,
   `SHA256SUMS`, `stable.json` y notas. Tras la aprobación de Aldo, publicarlo
   inicialmente sin marcarlo como la última versión.
3. Comprobar las descargas públicas y sus huellas. Promover la entrega a
   última estable y verificar el canal firmado público. Usar los enlaces
   comprobados en los tres botones del sitio.
4. Conservar las versiones publicadas. Si aparece un fallo, restaurar el
   canal y los enlaces anteriores mientras se prepara un parche superior.
   Las instalaciones que ya se actualizaron se corrigen con ese parche.

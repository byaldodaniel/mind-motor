# Workflow de Mind y primera versión Windows

Decisiones de Aldo: 2026-11-02, America/Lima.

- Repo 2, privado: `byaldodaniel/mind-motor`. Desarrollar por ramas y PR,
  integrar y validar aquí. Trabajo local en `Mind - Desarrollo`.
- Repo 1, público: `byaldodaniel/mind-updates`. Publicar exclusivamente el
  producto listo para descargar, su canal firmado y notas de versión.
- Primera entrega estable: **Mind 1.0.0 para Windows x64**. Linux y macOS
  quedan para entregas posteriores y no bloquean esta publicación.
- Actualizaciones: comprobar al iniciar, descargar el paquete estable firmado
  de la plataforma y aplicar cuando no haya sesiones activas.
- Acceso: la carpeta abierta por el cliente o iniciador tiene acceso completo
  durante esa sesión, sin otra autorización de Mind. Borrar conserva confirmación.

## Cierre de una versión

1. Completar el alcance acordado en repo 2.
2. Pasar las pruebas automáticas de Windows, incluidas las regresiones corregidas.
3. Construir el paquete portable desde un commit limpio, verificarlo, extraerlo
   y ejecutar las pruebas de producto con sus propios runtimes y datos ficticios.
4. Comprobar la actualización y conservación de la Base, y la apertura sin
   formulario del proyecto. Documentar las limitaciones comprobadas.
5. Integrar la versión terminada en repo 2 y etiquetar el commit de publicación.
6. Firmar el canal y subir el ZIP, `SHA256SUMS`, `stable.json` y notas al
   borrador de la release de repo 1. Comprobar el contenido y publicar.
7. Verificar las descargas públicas y su firma. Una versión publicada se conserva;
   las correcciones se entregan con una versión posterior.

`packaging/publicacion.json` define las plataformas exigidas en cada entrega.
GitHub Actions está bloqueado por facturación; para esta entrega las pruebas y
la construcción se ejecutan localmente en Windows. El workflow acordado no
requiere Cloudflare ni cambiar el presupuesto para publicar esta versión.

La primera descarga incluye ya el actualizador. Las copias anteriores deben
recibir una vez este paquete, usando la actualización manual con Mind cerrado.
La instalación personal de Aldo se actualiza en una operación separada.

# Incremento 01 — núcleo ejecutable

## Implementación

- Motor nuevo en JavaScript ESM y Node.js 24 LTS, sin dependencias externas.
- CLI local de una operación por proceso y API asíncrona de apertura, escritura y lectura.
- Base explícita, externa y persistente; almacenamiento JSON de registros técnicos de texto.
- Validación de rutas físicas para impedir solapamiento entre Motor y Base.
- Escritura con temporal exclusivo, sincronización del contenido y renombrado.
- Interfaces mínimas actuales y puntos de incorporación de las cinco capacidades documentados.
- Workflow nuevo para probar Windows, macOS y Linux.

Node.js 24 es una línea LTS. Se eligieron las API integradas de archivos y pruebas
para evitar dependencias y compilación en este primer núcleo. El formato JSON
favorece una inspección sencilla de registros pequeños; no se afirma escalabilidad
de una base de datos ni transacciones generales.

Referencias técnicas:
- https://nodejs.org/en/about/previous-releases
- https://nodejs.org/docs/latest-v24.x/api/fs.html
- https://nodejs.org/docs/latest-v24.x/api/test.html

## Verificación local

Windows, Node.js v24.18.0: `node --test` terminó con **11 pruebas aprobadas,
0 fallos, 0 omitidas**. Incluye escritura y recuperación desde procesos separados
y terminados, comparación de huellas del contenido del Motor antes y después,
independencia de dos Bases, rutas que se solapan y un alias de directorio,
validación de entradas, datos corruptos, rechazo de registros enlazados y limpieza
después de una escritura fallida. La CLI también escribió y recuperó el registro
ficticio `incremento-01` en la Base de desarrollo, mediante procesos separados.

La ejecución en GitHub Actions se informa en la pull request; este documento no
anticipa resultados de otras plataformas antes de obtenerlos.

## Límites

Solo registros técnicos ficticios de texto. No hay funciones de dominio, historial,
control de permisos de agentes, garantías ante cortes de energía ni aislamiento
frente a procesos hostiles. No se utiliza ni modifica la instalación personal.

## Siguiente incremento propuesto

Incorporar el registro explícito de carpetas autorizadas en la Base como fundamento
para un primer acceso controlado a información original. El alcance y sus pruebas
se aprobarán antes de implementarlo; no se inicia con este incremento.

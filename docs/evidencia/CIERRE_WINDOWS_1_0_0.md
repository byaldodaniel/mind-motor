# Cierre de Mind 1.0.0 — Windows x64

Alcance aprobado por Aldo el 2026-11-02 (America/Lima): publicar primero Windows.
Workflow: desarrollar y terminar en `mind-motor` (privado), distribuir paquetes
terminados y el canal firmado en `mind-updates` (público).

## Comprobaciones

- Suite completa local: JavaScript 308 pruebas, 306 aprobadas y 2 omitidas;
  Python 51 pruebas, 48 aprobadas y 3 omitidas. Total: **354 aprobadas,
  5 omitidas, cero fallos**.
- Defecto de movimientos simultáneos corregido: Windows ya no comparte DELETE
  sobre el objeto retenido. La regresión con procesos independientes falla en
  la versión anterior y pasa con la corrección, para archivo y carpeta.
- **24/24 casos de producto superados**, desde el ZIP extraído, con los runtimes
  incluidos. Incluye conexión MCP con Claude Code 2.1.316 real (sin ejecutar un
  modelo), organización, papelera, propiedades, índices, funciones, respaldo y
  actualización con conservación de la Base.
- Ensayo completo del iniciador: 1.0.0 → 1.0.1 con un canal firmado local y un
  paquete real; descarga, instalación, reinicio con el runtime nuevo, lectura y
  creación en el proyecto sin formularios, identidad y continuidad de la Base
  conservadas. La versión de ensayo 1.0.1 no se publica.
- Carpeta abierta observada desde la primera sesión; un cambio externo aparece
  en el índice sin una búsqueda que fuerce la reconciliación.
- Construcción desde los blobs del commit: evita diferencias por CRLF del editor.
  Dos construcciones del paquete final dieron el mismo SHA-256.

## Artefacto validado

- Código empaquetado: `4335a99`.
- Archivo: `Mind-1.0.0-win32-x64.zip`.
- SHA-256: `7a212cf4d90f3fbfc47c3a50f1317f8de23ceeee91abe03e45b1bd60ddbc9466`.
- Los commits posteriores solo corrigen el arnés de ensayo y registran evidencia;
  no cambian Motor, runtimes, plantillas ni otros archivos del paquete validado.

## Alcance y límites

Windows x64 es la única plataforma de esta publicación. Linux y macOS quedan
para entregas posteriores. Actions sigue sin iniciar por facturación; la
validación es local y no se presenta como CI remoto aprobado. Los datos usados
fueron ficticios; no se actualizó la instalación personal de Aldo.

El acceso automático requiere que el cliente comunique las raíces, inicie Mind
desde el proyecto o configure `--carpeta`. La primera conexión al agente se hace
una vez. El paquete y las actualizaciones no constituyen aislamiento del SO.
La firma Ed25519 verifica el canal y los paquetes; no equivale a Authenticode
del conjunto de Mind. El respaldo cifrado no tiene auditoría criptográfica externa.

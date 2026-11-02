# Mind 1.0 — avance, decisiones y criterios

Documento de continuidad del desarrollo. Permite retomar el trabajo sin depender de
la memoria de ninguna conversación. Se actualiza en cada hito.

- Rama de integración: `claude/dazzling-archimedes-kgyug3` (PR #21, borrador, sin fusionar).
- Base de partida: `main` en `e452e77` (incluye #17 y #18).
- Estado global: **candidato parcial**. No declarar terminado hasta cumplir los
  criterios de la sección final.

## Estado por componente

Estados: **Implementado y probado** · **Desarrollado, pendiente de integración** ·
**Pendiente de construcción** · **Bloqueado**.

| Componente | Estado | Evidencia | Pendiente |
|---|---|---|---|
| Consolidación #16 + #19 + #20 | Implementado y probado | Commits `86fb96d`, `855aee4`, `f05da1f`; suite combinada en verde; CI en Windows, macOS y Linux | — |
| Defecto Windows `ACCESS_DENIED` / `FILE_EXISTS` | Implementado y probado | Reproducido en CI antes de corregir (run 41358101441); corregido en `abfb13a` (run 41358364405) | — |
| Servidor MCP sin dependencias (stdio, 2025-11-25) | Implementado y probado | `src/mcp-server.js`; `test/mcp-server.test.js` | — |
| Sesión ligada al agente (abrir/crear Base, reconciliar, observar, cerrar) | Implementado y probado | `src/session.js`, `src/mcp-session.js`; `test/mcp-lifecycle.test.js`; casos 5, 11 y 12 desde el paquete en 5 plataformas | — |
| Consentimiento (formulario del cliente o consola; elección única) | Implementado y probado | `src/consent.js`, `src/console.js`; `test/agent-session.test.js` | Formulario interactivo de Claude Code probado por una persona |
| Permisos separados por carpeta (encontrar, leer, escribir, organizar) | Implementado y probado | `src/access-policy.js`, ligados a la generación del registro | — |
| Exclusiones de subcarpetas | Implementado y probado | Registro v3; `test/exclusions.test.js`; prueba nativa | — |
| Herramientas: estado, buscar, explorar, leer, crear, modificar, editar | Implementado y probado | `src/agent-tools.js`; pruebas de sesión | — |
| Continuidad para agentes (registrar, consultar, actualizar, exportar, importar) | Implementado y probado | Pruebas de sesión; agente real recupera una decisión de otra sesión | — |
| Rastro de eliminados y referencias rotas | Implementado y probado | `src/removals.js`; herramienta `eliminados` | — |
| Recuperación automática de bloqueos abandonados | Implementado y probado | `src/index-lock.js`; `test/index-lock.test.js`; `docs/CONCURRENCIA_INDICES.md` | — |
| Consola: autorizar, permisos, reparar, estado, herramienta | Implementado y probado | `src/console.js`, `src/product-cli.js` | — |
| Prueba con agente real (Claude Code 2.1.316) | Implementado y probado | `docs/evidencia/AGENTE_REAL_2026-11-01.md`; desde la carpeta extraída del paquete Linux x64: `docs/evidencia/HITO_A_AGENTE_REAL_2026-11-02.md` | Formulario interactivo con una persona; otros agentes sin configurar |
| Organizar (crear carpetas, mover) | Hito B: escrito, sin conectar | `src/organizer.js`, `src/native_organizer.py` (WIP del subagente A) | Conectar al Motor y al agente; pruebas en 3 sistemas |
| Borrar con confirmación, auditoría y papelera | Hito B: escrito, sin conectar | `src/trash.js` (WIP) | Conectar, confirmación, pruebas |
| Propiedades y búsqueda por propiedades | Hito B: en el Motor, sin herramienta | `src/properties.js` (WIP del subagente C) | Herramienta del agente, pruebas |
| Índices personalizados CSV | Hito B: sin empezar | — | Diseño, código, pruebas |
| Función 04: ejecutores, automatizaciones en sesión y programador del sistema | Hito B: escrito, sin registrar | Registro y ejecución manual en el Motor (#20); `src/automations/`, `src/executors/` (WIP) | Herramienta, consentimiento de activación, órdenes, pruebas |
| Respaldo cifrado y recuperación (código físico y archivo protegido) | Hito B: módulo escrito, sin conectar | `src/backup.js` (WIP; prueba manual) | Orden, pruebas, revisión criptográfica externa |
| Paquetes portables (Hito A): linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64 | Implementado y probado | `scripts/construir-paquetes.mjs` (reproducible, huellas oficiales), `packaging/iniciadores/`, `.github/workflows/paquetes.yml`, `docs/DISTRIBUCION.md` | Experiencia sin firma (Gatekeeper, SmartScreen) comprobada por una persona |
| Actualización segura del Motor (`mind actualizar`) | Hito B: escrito, sin registrar ni probar | `src/commands/actualizar.js`; Base protegida contra versiones anteriores (`BASE_TOO_NEW`) | Pruebas de extremo a extremo |
| Pruebas de producto (12 recorridos del Hito A) desde la carpeta extraída | Implementado y probado | `scripts/producto-12-casos.mjs` (PATH vacío, Claude Code real en el caso 4) y `scripts/producto-cuarentena-macos.mjs`, en CI para las 5 plataformas | — |
| Comparativas con y sin Mind | En construcción (subagente F) | — | Resultados reales |
| Firma de código y notarización | Bloqueado | El usuario decidió no pagar certificados | Avisos documentados; cuarentena de macOS mitigada (opción B) |

## Decisiones vigentes (aprobadas por el usuario)

| Fecha | Decisión |
|---|---|
| 2026-11-01 | Sesiones ligadas al agente (opción B del encargo). Sin servicio permanente. |
| 2026-11-01 | Recuperación automática de bloqueos de índice abandonados (opción B): solo si el bloqueo es de este equipo y su proceso ya no existe. `mind reparar` queda como respaldo. |
| 2026-11-01 | Licencia propietaria. Titular: Aldo Daniel. Previsto transferirla a Api D'Uniam Enterprises. |
| 2026-11-01 | Consentimiento con una sola elección por carpeta: solo encontrar, encontrar y leer, o acceso completo. Se recuerda hasta retirarlo. Internamente los permisos siguen separados. |
| 2026-11-01 | El acceso a una carpeta cubre todo su contenido, salvo las exclusiones que el usuario elija (opción b). El agente puede excluir más; solo el usuario vuelve a incluir. |
| 2026-11-01 | Borrar en 1.0: confirmación en cada operación, registro en la auditoría y papelera de Mind recuperable; vaciarla pide una segunda confirmación. |
| 2026-11-01 | Archivos eliminados fuera de Mind: rastro de solo metadatos durante 30 días y referencias de continuidad marcadas como rotas, en versión simple. |
| 2026-11-01 | Automatizaciones fuera de sesión: se construyen ya, con el programador del sistema operativo, con autorización explícita del usuario. |
| 2026-11-01 | Sin firma de código de pago. En macOS, Mind verifica los SHA-256 de sus propios runtimes y retira la cuarentena solo en su carpeta (opción B). |
| 2026-11-02 | Hito A: primer producto portable con las capacidades ya probadas. Organizar, papelera, propiedades, CSV, automatizaciones, respaldo y `mind actualizar` pasan al Hito B y no se ofrecen hasta estar conectados y probados. |

## Decisiones técnicas del desarrollo

- **Punto de entrada:** MCP por stdio, el mecanismo que los agentes con herramientas locales ya entienden. Claude Code descubre `.mcp.json` en la carpeta abierta y pide al usuario aprobar el servidor una vez; esa aprobación es su consentimiento para ejecutar el programa. El paquete no lo preaprueba.
- **Modo sin MCP:** `mind herramienta <nombre> [json]` ejecuta las mismas herramientas en operaciones individuales, reconciliando bajo demanda y sin observación continua.
- **Anfitrión de confianza:** el proceso MCP conserva el Motor administrativo. El agente solo recibe herramientas que, en cada operación, comprueban la decisión del usuario y piden al Motor un permiso de un solo intento ligado a la identidad opaca de esa conexión. La identidad del cliente (`clientInfo`) es declarada y se muestra como tal.
- **Contenido en datos estructurados:** Claude Code entrega al modelo `structuredContent`, no el bloque de texto. Las herramientas que devuelven contenido lo incluyen en ambos canales. Lo detectó la prueba con agente real.
- **Formulario cancelado:** se trata como "pendiente para la consola", no como rechazo. En modo sin interfaz el cliente cancela el formulario.
- **Límite de seguridad:** Mind no es un aislamiento del sistema. Un agente que ya ejecuta programas con los permisos del usuario puede eludir cualquier mecanismo de ese usuario, incluso emular un terminal. Las garantías cubren lo que se hace a través de Mind.
- **Puntos de extensión** para el desarrollo en paralelo: `src/tools/index.js` (herramientas), `src/commands/index.js` (órdenes) y `src/session-extensions.js` (ciclo de vida).

## Dependencias y orden

1. Organizar (A) → borrar y papelera (A) → las propiedades siguen al mover (C, al integrar).
2. Propiedades (C) → índices CSV con campos de propiedad (C).
3. Ejecutores de respaldo (B) e índice CSV (C) → automatizaciones (E), al integrar.
4. Paquetes (D) → cuarentena de macOS y `mind actualizar` (D) → pruebas de producto (12 casos) → prueba final con agente real desde la carpeta extraída.

## Cómo continuar

- Pruebas: `npm test`. Como root fallan las pruebas de denegación de permisos; ejecutarlas como usuario sin privilegios.
- Agente real: véase `docs/evidencia/AGENTE_REAL_2026-11-01.md`, que incluye la configuración con `CLAUDE_CONFIG_DIR` temporal.
- Integrar cada área desde su rama y ejecutar la suite completa y el CI antes de seguir.

## Criterios para declarar Mind 1.0 terminado

- [ ] Las cinco funciones cubren sus requisitos aprobados o identifican explícitamente un alcance pendiente de aprobación.
- [ ] Las capacidades funcionan integradas.
- [x] El usuario puede descargar y extraer la carpeta portable (Hito A: artefactos del CI, sin publicación de producción).
- [x] Un agente compatible reconoce e inicia Mind con mínima intervención (Claude Code, desde la carpeta extraída en las 5 plataformas).
- [x] El Motor usa la Base persistente correctamente.
- [x] La observación se activa durante la sesión y se detiene al cerrarla.
- [x] El agente no puede falsificar las autorizaciones a través de Mind.
- [x] Los originales permanecen en sus ubicaciones.
- [ ] Actualizar el Motor no destruye la Base: probado de extremo a extremo (`mind actualizar`).
- [x] Hay pruebas automatizadas de los recorridos principales. Falta añadir las de las áreas en construcción.
- [x] Los paquetes se comprobaron en las plataformas declaradas (CI en las 5; el modelo real, solo en Linux x64).
- [x] Hay pruebas reales con agentes, también desde la carpeta extraída del paquete.
- [ ] Los resultados comparativos se presentan con evidencia.

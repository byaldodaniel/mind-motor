# Contratos de integración — piloto nativo Mind 1.0.4-r3

Fecha: 16 de noviembre de 2026. Responsable: Codex, Etapa 5.
Estado: contrato de compatibilidad del puente + IPC del piloto + contraste del catálogo en desarrollo. **La fuente de Claude ya declara Base 3 e incorpora catalog.sqlite; esto no acredita migración ni instalación real.** El SQL de Codex sigue siendo una propuesta distinta, no aplicada. Véase la alineación y sus hashes en la sección 9.

Se leyeron las secciones 4, 5 y 6 del Frente de Desarrollo de Mind. Prevalece la consolidación 6: residente con HTTP directo, extracción con permiso leer, agrupación inferior a 1 s, piloto Rust/Go y entrega por puertas. Claude construye etapas 0–4 en Motor; este trabajo sólo escribe dentro del piloto. No se ejecutó la instalación personal de Mind ni se abrió una Base real para escritura. La integración B1 del piloto sí ejecuta el Motor r2 congelado en reference/motor-r2, con Base ficticia bajo runs; esto no acredita el Motor vigente de Claude.

## 1. Vigencia y versiones que no deben confundirse

| Pieza | Fuente examinada | Estado observado |
|---|---|---|
| Formato global Base | Motor/src/base-format.js:15 | BASE_FORMAT_VERSION = 3 en la fuente nueva de Claude; barrera prepareBaseFormat antes de guardar índices. No se ejecutó sobre la Base real. |
| Índices de archivos | Motor/src/index-store.js:144–207 y sqlite-catalog.js | catalog.sqlite es la persistencia nueva; load migra el JSON legado validado. Tipos y estados anteriores conservados. Ver diferencias de esquema en sección 9. |
| Propiedades | Motor/src/properties.js:232,245–257 | folder-properties-ID.json, versiones 1/2, identidad posix:N:N o nt:N:N, generación de autorización. |
| SQLite de conversaciones | Motor/src/conversations.js:176–186 | conversation-index.sqlite sigue separado, user_version=2; files, conversations FTS5, conversation_vectors. |
| Transporte Mind | connector.js, motor-central.js, mcp-bridge.js | /health HMAC v1, /rpc interno, /mcp Streamable HTTP. |
| MCP negociable | Motor/src/mcp-core.js:13–14 | 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05; límite publicado 16 MiB. |
| Revisión de paquete | manifest.packageRevision | Independiente de motorVersion. El octavo test obliga a detectar cambio de revisión aunque versión sea igual. |

El formato global 3, la revisión SQL 3, la revisión de paquete 3, la versión MCP y el contrato IPC 1 son ejes distintos. No reutilizar un número como prueba de compatibilidad del otro.

La lectura de fuentes se realizó con Claude trabajando en paralelo. La integración debe comparar nuevamente estas interfaces y registrar hash/commit; un HEAD igual no acredita archivos sin cambios. reference/motor-r2 sirve de referencia congelada del piloto, no de fuente vigente de las etapas 0–4.

## 2. Puente ↔ Motor: contrato compatible con r2

### Descubrimiento, identidad y HMAC

1. Resolver la Base física y leer conector.json como archivo regular de confianza. Su version es 1. Validar puerto entero 1–65535 y baseId esperado.
2. La identidad del conector **no es** el UUID durable de mind-base.json. baseIdOf usa SHA-256 de la ruta absoluta normalizada NFC, minúsculas en Windows/macOS según paths.js, y conserva los primeros 16 caracteres hex. Linux distingue mayúsculas. El piloto debe replicar este comportamiento para compatibilidad; una política futura por volumen requiere negociación/migración.
3. Leer conector-secreto.json sin seguir enlaces y verificar version=1, token de longitud suficiente. Nunca crearlo/regenerarlo desde el puente.
4. Antes de enviar Bearer, GET http://127.0.0.1:PORT/health?nonce=NONCE. NONCE nuevo y aleatorio por comprobación (r2 genera 16 bytes en hex).
5. Exigir ok=true, puerto exacto, baseId exacto y proof correcta. Cálculo exacto:
   - algoritmo HMAC-SHA256;
   - clave: bytes UTF-8 del token STRING guardado; **no decodificar ese texto hex como 32 bytes**;
   - mensaje UTF-8: mind-health-v1, LF, nonce, LF, baseId, LF, puerto decimal;
   - no LF final; salida hex minúscula; comparación en tiempo constante.
6. Sólo tras verificar identidad enviar Authorization: Bearer TOKEN. No redirigir solicitudes ni enviar token a otro host; desactivar proxies para este transporte loopback.

health-v1.schema.json describe la forma mínima de una respuesta exitosa, no sustituye la comprobación criptográfica. Una respuesta HTTP 200 sin proof no basta. El PID tampoco acredita identidad. La prueba v1 vincula nonce/baseId/puerto; motorVersion, packageRevision y capacidades no forman parte de su mensaje HMAC. La entrega del programa se verifica con el mecanismo firmado del producto, no con esta prueba.

### HTTP, sesión y mensajes

- Destino fijo 127.0.0.1; Host exacto 127.0.0.1:PORT; cualquier Origin es rechazado por el Motor actual. No usar localhost ni URL arbitraria del estado.
- /mcp es Streamable HTTP: POST puede devolver JSON o text/event-stream; GET abre SSE de la misma ruta; DELETE cierra sesión. No confundirlo con el antiguo transporte separado /sse.
- Conservar ids JSON-RPC (cadena o entero seguro) y recibir solicitudes del servidor, respuestas y notificaciones. stdout sólo contiene JSONL; diagnóstico a stderr.
- initialize crea una sesión. Conservar Mcp-Session-Id; enviar sólo durante initialize X-Mind-Workspace = base64url(UTF-8 JSON {cwd,paths,conexion}), sin padding obligatorio. conexion es UUID estable del chat/puente.
- cwd/paths son declaraciones de contexto. El Motor resuelve permisos y vigencia del ámbito; ni una ruta ni un UUID conceden acceso.
- Barrera: initialize remoto, luego notifications/initialized remoto, luego cualquier herramienta posterior. No serializar toda la sesión: una llamada puede esperar elicitation/create y necesita que la respuesta del cliente avance en paralelo.
- POST acepta application/json y text/event-stream; implementar eventos SSE fragmentados, CRLF/LF, múltiples data: unidos por LF, comentarios, eventos separados por línea vacía y flujo de cierre. No exigir que un chunk sea JSON completo.
- Los eventos y las respuestas HTTP pueden compartir una petición. Entregar exactamente una respuesta final por id. Las notificaciones no generan respuesta.
- Error de herramienta: result.isError=true y structuredContent.error={codigo,mensaje,detalles?}; no sustituir por éxito vacío. Error de protocolo: error JSON-RPC.
- El puente no ejecuta herramientas, no escribe índices y no concede permisos. Debe usar el arranque/relevo administrado del producto, con argumentos estructurados, sin shell/interpolación de rutas.

### Reintento, caída, ping y revisión

- Un 401, 404 de sesión o 503 de cierre son rechazos anteriores al procesamiento según el contrato actual. Reabrir sesión y reintentar una sola vez. 403 Host/Origin no es un error transitorio de credenciales.
- Si no se estableció conexión, puede repetirse tras redescubrimiento. Si la conexión pudo entregar una mutación y se cortó, devolver MOTOR_CONNECTION_LOST: resultado indeterminado, **sin repetir la escritura**.
- Reintentar sólo una lectura conocida por la misma clasificación del Motor. Herramientas desconocidas se consideran mutaciones. La lista de sólo lectura debe generarse/versionarse desde el catálogo; no inferirla por prefijo del nombre.
- Fallo de arranque transitorio: initialize degradado con lista estado, isError en llamada y recuperación en próxima llamada real; al recuperar, notifications/tools/list_changed.
- Fallos deterministas BASE_TOO_NEW, BASE_MARKER_CORRUPT, RUNTIME_MISSING, INVALID_BASE o BASE_OVERLAPS_MOTOR no producen bucle de arranque.
- ping o reconexión SSE no arrancan el Motor. Con el residente r3, mantienen esta semántica: ausencia no autoriza un arranque por keepalive.
- Comparar par (motorVersion,packageRevision). Tras detectar otra revisión instalada, ceder al programa instalado una sola vez por transición; preservar initialize y estado initialized. El puente antiguo no ejecuta herramientas contra la revisión nueva.
- No matar procesos por PID guardado. El relevo conserva las comprobaciones de identidad y los límites de recursión del producto.

### /rpc interno

/rpc no es JSON-RPC MCP. Acepta POST autenticado con accion: inicio, estado, herramienta, ping, quietud, apagar y la acción restringida verificar-actualizacion. Una herramienta lleva tool,args y opcionalmente cwd/paths. La respuesta puede ser {ok:true,value,text,isError}; **ok:true,isError:true sigue siendo fallo de herramienta**. También existe {ok:false,error:{codigo,mensaje,detalles}} y {ok:false,busy:true} al apagar condicionado.

rpc-v1.schema.json describe el sobre de aplicación existente. Errores HTTP de transporte como {error:"UNAUTHORIZED"} quedan fuera de ese sobre. El modo verificar-actualizacion exige además X-Mind-Update-Verification, pertenece al relevista y no se expone al agente ni al auxiliar.

### Versionado aditivo propuesto

Conservar v1 ausente como legado. Añadir en una revisión posterior campos opcionales de /health:
mindProtocol:{major:1,minor:N}, capabilities:["workspace-v1","safe-retry-v1","package-revision-v1",...].
No declararlos implementados hoy. Los campos desconocidos aditivos se ignoran; major desconocida se rechaza antes de mutaciones. Las capacidades nuevas no se deducen de motorVersion. Cambios de identidad/HMAC requieren una nueva versión explícita; nunca reinterpretar health-v1.

## 3. Escáner nativo por directorio: IPC v1 del piloto

Orden: ejecutable scan. Entrada/salida JSON Lines UTF-8 por stdin/stdout, un objeto por línea. El modo scan no lanza ni descubre Mind. Padre autorizado conserva la cola y los permisos.

Solicitud común:
{"id":"scan-1","root":"RUTA_ABSOLUTA_DEL_HOST","relative":"rama/subrama","maxEntries":10000}
Respuesta común:
{"id":"scan-1","entries":[{"name":"nota.md","type":"file","size":12,"identity":"posix:1:2"}],"complete":true}

- id identifica sólo la petición; root proviene del registro autorizado del host. relative opcional/vacío designa root. maxEntries es una cota de salida, no una autorización ni un cursor. Omitido usa 100.000; explícito debe estar entre 1 y 1.000.000. id debe ser cadena no vacía de hasta 128 caracteres o entero entre 0 y 2^53−1; un error previo a validar id devuelve id:null, nunca éxito.
- Tipos: file, directory, link, other, unknown. name es sólo el nombre del hijo inmediato, nunca ruta completa. size e identity son opcionales cuando no se pueden acreditar; no inventar cero/identidad. Identidad exportada: nt:VOLUMEN:FILE_ID en Windows y posix:DISPOSITIVO:INODO en POSIX, enteros decimales sin pérdida; si file ID no está disponible, omitir identity. La integración exige identidad verificada para publicar asociaciones de propiedades.
- Mantener nombres originales, incluido NFD; normalización de búsqueda y clave de comparación se hacen aparte. No cambiar un nombre al abrirlo. Nombres de bytes no UTF-8 o UTF-16 inválido requieren error explícito o una extensión versionada de nombre binario; no reemplazo silencioso que colisione.
- Validar semánticamente: root absoluta; relative sólo segmentos separados por /, sin vacío interior, ., .., NUL, barra invertida, unidad, UNC, dispositivo o ADS. name nunca . o .. ni separadores/NUL. El schema es estructural y no reemplaza estas comprobaciones por plataforma.
- Una petición sólo lista ese directorio. No recurre, hidrata contenido de nube, calcula hashes de archivos ni abre documentos.
- Error: {id,entries,complete:false,error:{code,message,retryable?}}. Códigos sugeridos INVALID_REQUEST, SCOPE_UNSAFE, LINK_NOT_ALLOWED, IDENTITY_CHANGED, ACCESS_DENIED, NOT_FOUND, LIMIT_REACHED, CANCELLED, UNSUPPORTED_PLATFORM, IO_ERROR.
- Tras EOF terminar sin dejar hijos. Cota común del piloto: 16 MiB de entrada por línea, contados en bytes UTF-8, también cuando la línea termina en LF. Cotas explícitas de memoria, respuesta, número de peticiones en vuelo y plazo. Rechazar el exceso; no acumular stdout/SSE indefinidamente. La cota de 16 MiB del puente es distinta de una cota operativa del escáner y debe medirse.

### Apertura segura y carrera

La comprobación real es abrir por referencia, no comparar cadenas y abrir después. El host mantiene el permiso de encontrar; lectura de contenido exige leer. El auxiliar sólo posee la capacidad temporal de enumeración que el host le entrega por un canal privado.

POSIX: abrir raíz y cada componente mediante descriptores, O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC; enumeración y stat relativos a ese descriptor sin seguir enlaces. Windows: abrir directorio y componentes mediante handles, impedir seguimiento de reparse points y comprobar identidad (volumen/file ID); enumerar desde el handle. FILE_FLAG_OPEN_REPARSE_POINT aplicado sólo al último componente de una ruta completa **no protege ancestros**. Usar apertura relativa a handles o mecanismo equivalente demostrado; fallar cerrado si la plataforma no puede dar la garantía.

Realpath seguido de read_dir, Lstat seguido de Open y comprobar únicamente que una ruta empieza por root son insuficientes ante intercambio concurrente. Go os.OpenRoot y Rust std::fs::read_dir tampoco acreditan por su nombre la política estricta de no seguir enlaces; deben inspeccionarse y probarse. Los enlaces encontrados pueden devolverse como link, pero no recorrerse.

Identidad registrada del root/directorio debe compararse al abrir y antes de confirmar publicación. La versión v1 de solicitud no lleva identidad esperada ni handle heredado: depende de que el host conserve la capacidad/identidad y de que el auxiliar abra sin atravesar enlaces. Para integración productiva agregar una capacidad opaca o handle heredado y expectedIdentity mediante versión/capacidad negociada; el piloto de ruta no se presenta como frontera de autorización frente a otros procesos del usuario.

### Complete, lotes y cobertura

complete=true significa fin de la enumeración de ese directorio sin truncamiento ni error; **no significa árbol completo ni snapshot atómico del sistema de archivos**. Comparar identidad/generación y eventos concurrentes; un cambio durante el recorrido encola reconciliación.

Con complete=false publicar sólo avance positivo validado, sin marcar ausentes como eliminados. No devolver porcentaje global inventado: devolver directorios confirmados/pendientes/inaccesibles, última lectura y snapshotGeneration.

IPC v1 tiene una respuesta por petición y no tiene cursor. Si maxEntries trunca, retornar complete=false; se recomienda error LIMIT_REACHED y no repetir infinitamente el mismo prefijo. Esta limitación debe figurar en el piloto. Para producción y directorios gigantes, negociar scan-batches-v2: lotes con scanId,sequence,final,complete y handle vivo en auxiliar; registrar los lotes en staging. Tras reinicio perder el cursor del SO, descartar intento incompleto y reabrir directorio; no persistir el valor numérico de un handle. Sólo al final confirmado reconciliar ausentes en transacción. Un trabajo por directorio permite progreso entre ramas sin ese cursor; no resuelve por sí solo un directorio con millones de hijos.

## 4. Propuesta SQL de Codex y condiciones de integración de Base 3

contracts/base-v3.draft.sql es **borrador no aplicado**, preservado sin cambiar su DDL. No coincide con el catálogo que Claude ya incorporó: el mapeo de la sección 9 y contracts/base-v3.claude-observed.sql describen la nueva fuente observada. El borrador propone user_version=3; el catálogo de Claude no declara aún PRAGMA user_version. Ninguno de esos números debe confundirse con Base global=3 en mind-base.json. No cambiar user_version de conversation-index.sqlite, que permanece en 2. El contrato SQL se congela sólo tras acordar esquema, migración, consultas y pruebas.

Tablas: scopes, entries (padre/ruta/identidad), directory_scans+scan_staging, jobs, blocks, property_definitions, property_aliases y property_values. Mantener identidad/generación de autorización y procedencia. Los registros del catálogo no conceden permisos: el registro administrativo y la sesión siguen siendo autoridad.

Reglas de integración obligatorias:

1. Un escritor transaccional, lecturas por snapshot; WAL sólo en almacenamiento local que lo soporte. No asumir que una ruta aparentemente local en Drive sea apta. No crear bases compartidas por varias máquinas con WAL.
2. Migración conserva UUID y fechas de mind-base.json; valida JSON fuente, generación e identidad. Legacy con authorizationGeneration=null se importa como no vinculado y no se vuelve autorización vigente. Conservar tipos string/number/boolean, valor original e identidad de propiedades; no reasignarlas por coincidencia de ruta a otro archivo.
3. Publicar generación de permiso y de snapshot con CAS dentro de la misma transacción que entradas/cobertura. Una revocación invalida trabajo en vuelo y bloquea consultas/conteos inmediatamente.
4. entries raíz usa relative_path/path_key vacíos y parent_id NULL. Todos los otros padres deben pertenecer al mismo ámbito; normalización sigue política del volumen, no una regla universal de minúsculas. Hardlinks pueden compartir identity, así que identity no es clave única.
5. Reconciliación por directorio: staging de un scan, generación/identidad vigentes, aplicar altas/cambios y sólo si complete retirar hijos ausentes. Directorio inaccesible conserva snapshot y reporta unavailable; jamás se transforma en vacío.
6. Un trabajo running se recupera sólo tras acreditar que su instancia propietaria dejó de ser dueña. Una fecha lease vencida o PID por sí solos no autorizan ejecución duplicada ni borrado. Dedupe + prioridad con envejecimiento y presupuestos acotados.
7. Bloques: identificación estable por contenido/estructura, versión de fuente y extractor; líneas sólo localización. Reemplazar marcas de una versión en transacción, preservar asignaciones manuales. Cerrado, ejemplo, código y ambiguo son estados explícitos. Propuesta inicial: aliases sólo definidos por usuario. La fuente de Claude también siembra aliases predeterminados; la sección 9 exige acordar esa diferencia, conservar el original y permitir elección/redefinición del usuario.
8. property_values liga scope, entrada, identidad y versión de fuente. Una consulta une identidad/generación vigente y aplica permisos antes de conteos/muestras. Las marcas extraídas requieren permiso leer también para su conteo; comparar blocks.source_generation/source_fingerprint con entries.content_generation/content_fingerprint, sin volver a contar una extracción obsoleta. Separar filtro exacto por propiedad de FTS/semántica. Agrupación y buscar comparten normalización; paginar por clave, sin OFFSET creciente.
9. Cursores incluyen revisión de filtro, ámbitos y generación de snapshot. Si expiró la versión, informar CURSOR_EXPIRED o reiniciar declaradamente, no mezclar resultados.
10. Reversibilidad: construir catálogo nuevo en copia aislada, verificar integridad/conteos/propiedades, snapshot consistente de WAL, drenar, marcar formato 3 antes de exponer escrituras incompatibles y commit de migración durable. No anunciar rollback sin restaurar TODOS los archivos/registro de migración coherentes. Tras nuevas escrituras en 3, volver al respaldo 2 puede perder esos cambios: bloquear/explicar o proporcionar exportación inversa; no prometer rollback sin pérdida automáticamente.
11. Índice SQL es derivado, pero propiedades asignadas y aliases son datos del usuario: se respaldan y se verifican. No tratarlos como caché regenerable ni enviar datos personales a evidencia del piloto.

La validación de SQLite en memoria sólo acredita sintaxis/constraints del borrador; no rendimiento, migración real ni compatibilidad con las implementaciones concurrentes.

## 5. Matriz de las ocho pruebas originales y puerta del piloto

Fuente: Motor/test/mcp-bridge.test.js. No afirmar 7/7 si se omite la prueba de revisión que ya existe.

| ID | Línea | Caso vigente | Obligación del binario / integración |
|---|---:|---|---|
| B1 | 227 | Motor real, japonés y acento NFD | Arranque y lectura desde ambos cwd; permisos resueltos por Motor; no corrupción Unicode. Requiere Base ficticia aislada y Motor de referencia. |
| B2 | 250 | Workspace sólo initialize + barrera initialized | Cabecera base64url exacta con conexion UUID; ninguna herramienta antes de notificación recibida; header ausente después. |
| B3 | 283 | Motor desaparece y no despierta | Cada id recibe error; tools/call isError con MOTOR_START_FAILED; otros métodos error JSON-RPC; ningún silencio/stray. |
| B4 | 308 | 401 persistente | Una reapertura y un reintento; MOTOR_UNAUTHORIZED; exactamente dos buscar. |
| B5 | 327 | Corte de escritura frente a lectura | crear ejecutado una vez, MOTOR_CONNECTION_LOST; buscar dos veces y respuesta correcta. |
| B6 | 363 | Fallo transitorio y recuperación | initialize degradado, tools/list=estado; al recuperar initialized una vez, list_changed y catálogo completo. |
| B7 | 389 | Ping con Motor apagado | Respuesta vacía local, ningún intento de arranque, SSE no despierta. |
| B8 | 408 | Misma versión, revisión nueva | Relevo al ejecutable instalado; puente viejo hace cero herramientas contra revisión nueva. |

Los tests de referencia llaman runMcpBridge en proceso para B2–B8: no se pueden atribuir al candidato nativo simplemente ejecutándolos sin adaptación. Crear harness equivalente que lance cada binario y use los mismos motores falsos/aserciones; reportar por separado nativo, referencia e integración real B1. La migración Base3 se prueba en etapas 2/3 y no queda acreditada por B1.

Pruebas adicionales necesarias para promover el auxiliar: raíz/intermedio/final con symlink/junction/reparse; swap concurrente de directorio; revocación durante scan; directorio cambiado después de abrir; inaccesible; límite/truncación sin falsas bajas; Unicode y nombres no representables; cota de línea/salida; EOF/timeout/cancelación; ningún hijo remanente. En cada SO/arquitectura distinguir compilado, arrancado y funcionalmente probado.

Pruebas adicionales de puente: proof inválida y puerto reutilizado sin fuga Bearer; proxy/redirección desactivados; SSE fragmentado/multilínea; elicitation concurrente; cancelación temprana; ids cadena/entero; entrada mayor que cota incluyendo LF; presión de stdout; revisión repetida sin bucle de relevos.

## 6. Puerta para entregar y riesgos pendientes

Un candidato sólo puede llamarse reemplazo validado cuando pasa B1–B8 más la seguridad pertinente. Compilar seis destinos no demuestra ejecución en seis sistemas. Medir binario, privada/RSS en reposo, p50/p95 y procesos totales con fixture equivalente; no usar estimaciones de lenguaje como resultados.

Pendientes de integración: resolver las diferencias del catálogo de Claude documentadas en sección 9; fijar error/timeout/capacidades IPC comunes; resolver directorios que exceden maxEntries; garantizar apertura segura por SO; integrar arranque/relevo sin depender de un Node privado del piloto; comprobar HTTP directo de los clientes reales; firma/distribución del componente y comportamiento tras actualización. No se modifica Motor/src ni la Base real desde este contrato.

## 7. Revisión estática inicial de candidatos (16 de noviembre)

Ambos escáneres Windows examinados usan NtCreateFile con RootDirectory y rechazo de reparse para cada componente, y GetFileInformationByHandleEx para enumerar/metadatos sobre el handle retenido. Admiten sólo unidades locales fijas, rechazan UNC y reparse de nube; esto falla de forma cerrada, pero limita alcance y no acredita universalidad sobre Drive. No comprobé aquí su ejecución.

Diferencias comunicadas a implementadores: Go inicialmente emitía identity windows:V:F frente a nt:V:F de Rust y del Motor; la consolidación posterior exige que ambos exporten nt:V:F, evitando traducción implícita. Su forma de apertura y metadatos debe validarse antes de integrarlo; el schema por sí solo no acredita identidad física. Se detectaron reemplazo de UTF-16 inválido/UTF-8 no válido, error stat por entrada con complete=true, límites dispares e id sin validar. Sus correcciones deben comprobarse en la revisión final y no se consideran aprobadas sólo por haber sido comunicadas.

La revisión inicial Go POSIX usaba números raw de syscall para Darwin; la revisión posterior documentada en REVIEW.md ya emplea golang.org/x/sys/unix en las aperturas y metadatos relevantes. No presentar el riesgo de despacho raw como defecto activo tras ese cambio. La ejecución y los fixtures en Darwin siguen pendientes; compilar no acredita funcionamiento. Rust usa libc por destino y tampoco queda validado fuera de Windows sólo por compilar.

El SQL puede aplicarse repetidamente a una base vacía compatible mediante IF NOT EXISTS/INSERT OR IGNORE; esto no migra esquemas incompatibles existentes. Antes de ejecutar, el integrador debe comprobar contract/schema_revision y rechazar discrepancias, sin sobrescribir user_version de una base ajena. Las pruebas en memoria verifican idempotencia del borrador y restricciones; no certifican la migración real 2→3.

## 8. Validación ejecutada del borrador

contracts/validate_contracts.py ejecutado con Python aislado y sin bytecode sobre SQLite 3.53.1, conexión :memory:. Resultado final: **16 aprobadas, 0 fallos**. Evidencia: evidence/contract-tests.json (incluye SHA-256 exacto del SQL). Cubre sintaxis/integridad, user_version=3, reejecución sin pérdida de filas, claves de ámbito para padre/scan/job, unicidad de trabajos activos, tipos de propiedad, filtros antes de agrupar, revocación, identidad de archivo reemplazado, permiso leer para contar marcas y exclusión de versiones de contenido antiguas. También se parsearon los tres documentos JSON Schema.

No se abrió ningún archivo SQLite del usuario. No se probó una migración real 2→3, rollback, el sistema de permisos del Motor ni el rendimiento. El fixture demuestra un patrón correcto de consulta; el constructor debe aplicarlo a cada búsqueda, conteo y muestra de producción. El parseo de schemas no sustituye ejecutar un validador completo JSON Schema.

En una revisión posterior de las fuentes del piloto se observaron correcciones de nombres inválidos en Go y límites comunes en Rust. Se notificaron dos riesgos adicionales: Go readJSONFile hacía Lstat y luego Open sin apertura no-follow; Rust acumulaba toda la respuesta /health antes de comprobar su cota. Su estado final y pruebas corresponden a la revisión del candidato, no quedan aprobados por este documento.
Comprobación de evidencia de integración disponible al cerrar este aporte: evidence/go-bridge.tap registra 8/8 y evidence/go-scan.tap 1/1, sin fallos. Es la ejecución inicial del candidato que generó esos archivos; modificaciones posteriores requieren repetir el conjunto afectado y registrar el hash del binario. No se atribuye esta evidencia a Rust ni a todas las plataformas.

Revisión posterior de fuente: Go readJSONFile ya llama openRegularNoFollow; Rust limita /health por streaming a 64 KiB antes de acumular y acota ids MCP al entero seguro. Esto resuelve los mecanismos observados por lectura; su aprobación funcional depende de las pruebas del candidato final. Los schemas de scan son estrictos (additionalProperties=false en solicitud/respuesta/entrada/error); health y rpc conservan additionalProperties=true porque son sobres existentes extensibles, con autenticación/semántica verificadas fuera del schema. error en scan obliga complete=false; complete=false sin error sigue permitido para truncación. id:null sólo está admitido si la respuesta es un error.

## 9. Alineación con la fuente nueva de Claude — snapshot concurrente

Lectura y extracción: 2026-11-16 01:03:29 -05:00 (America/Lima), 2026-11-16T06:03:29.663Z (UTC). Se leyó código, no la Base instalada; no se ejecutaron Motor, SQL, pruebas ni builds para esta alineación. Claude continúa trabajando, por lo que los hashes son la referencia de esta observación y no una afirmación sobre archivos posteriores.

| Fuente capturada | SHA-256 |
|---|---|
| Motor/src/sqlite-catalog.js | c6b754f109a89d11e6fba79633ca5c655e174a13b297725156af3361706b68a4 |
| Motor/src/base-format.js | d9ce5f95ac0e19020a79dd6d5bd74acf2f72079d2407fbf9a99ffc9aedb54d82 |
| Motor/src/index-store.js | 9546af49f385e8fa18375a0189b5e898d58349225b040cda922b4a646c077c28 |
| Motor/src/index-scan.js | 56ae00e27ac8f2ca0b458325885d11d9ad041c8c4d948776bd5da37e91fe8e89 |
| Motor/src/marks-extractor.js | cd456b9614eac0c786b637abab4987fd0304d244866051278099b8b11c7cb7a6 |
| Motor/src/properties.js | 4c7954f01e95d47507d84e967a694abf517f91725220157b651a63abbaa3ecf7 |

contracts/base-v3.claude-observed.sql conserva literalmente el contenido de SCHEMA_SQL de sqlite-catalog.js:33–89, precedido por procedencia y fecha. No incluye pragmas ejecutados fuera del literal, aliases sembrados por JavaScript ni lógica de migración. **No ejecutarlo como instalador y no mezclarlo con base-v3.draft.sql.** La extracción conserva los mismos límites de la fuente; no introduce constraints ni corrige diferencias silenciosamente.

### Mapeo de los dos esquemas

| Concepto | Fuente de Claude observada | Borrador SQL de Codex | Acuerdo necesario |
|---|---|---|---|
| Versión | mind-base.json global 3; SCHEMA_SQL no asigna user_version ni catalog_meta. | catalog_meta + user_version=3, revisión del borrador. | Elegir versión propia del catálogo y rechazar versiones futuras antes de escribir. No deducirla del marcador global. |
| Ámbito | folder_scopes: root, authorization_generation, generation, timestamps, issues_json, revision UUID. | scopes: physical_root, case_policy, state, snapshot_generation, error/última verificación. | Conservar nombres de Claude para el candidato inmediato y definir equivalencia generation/snapshot_generation. Ruta y UUID no conceden permisos. |
| Entradas | folder_entries, PK(scope_id,path), identity y metadatos; sin fila raíz ni parent_id. | entries con entry_id, parent_id, path_key, identity y versión de contenido; raíz como entrada vacía. | Mantener adaptador del índice vigente sin inventar una raíz vacía: index-store.js:46–48 la rechaza. Árbol físico explícito es extensión/migración, no renombrado de columnas. |
| Política de comparación | path literal y eliminación por prefijos LIKE escapados. | path_key por política declarada del volumen. | Definir caso/Unicode por volumen y probar A/a y nombres con %/_; el escape de comodines no define sensibilidad a mayúsculas. |
| Propiedades asignadas | properties.js conserva folder-properties-ID.json v1/v2; generación e identidad verificadas por el almacén. | property_definitions/property_values tipadas con índices SQL. | El catálogo actual no migra estas propiedades. Preservar JSON y sus tipos hasta una migración explícita; no afirmar que una etiqueta de document_marks reemplaza toda propiedad arbitraria. |
| Marcas de texto | document_marks por scope/path/block_index/tag; heading, line_number, block_type, raw_tag, status, excerpt. | blocks con ancla/versión + property_values source=extracted. | block_index es posición, no identidad estable. Acordar versión del extractor/regla/fuente e identidad antes de reutilizar marcas tras reemplazos. |
| Huella de extracción | scanned_files por scope/path; entryFingerprint=size:modifiedAt:identity en marks-extractor.js:266–267. | content_fingerprint/content_generation en entrada y source_fingerprint/source_generation en bloques. | La huella actual es de metadatos; no llamarla hash de contenido. Incorporar versión de regla/extractor y comprobar que la lectura corresponde al mismo objeto/versionado que se publica. |
| Aliases | tag_aliases con alias único, canonical_tag y user_defined; semillas predeterminadas + redefinición personalizada. | property_aliases por property_id, valor canónico y revisión; propuesta sin semillas. | Decidir defaults visibles frente a sólo reglas del usuario. Preservar raw_tag y revisar invalidación cuando cambie un alias; no convertir sinónimos en propiedades autorizadas ni perder personalización. |
| Cola, staging y cobertura | No hay jobs, directory_scans ni scan_staging en este DDL. El cliente usa subpaths y mezcla de ramas. | Cola durable, staging y estado por directorio. | Distinguir actualización parcial de rama de cola persistente por directorio. Acordar almacenamiento y semántica complete antes de dar por implementada indexación progresiva durable. |
| Restricciones | PK/NOT NULL e índice tag/status; sin FK/CHECK/STRICT en el literal. | FK por ámbito, CHECK, STRICT, índices tipados y deduplicación de jobs. | Validación de aplicación existente no equivale a estos constraints. Añadirlos sólo con migración/fixtures de datos previos; no aplicar un CREATE IF NOT EXISTS alternativo sobre tablas existentes. |
| Publicación | BEGIN IMMEDIATE; snapshot completo o rama, revisión UUID. Indexer verifica permiso/generación antes y después bajo bloqueo. | CAS de generación y publicación de cobertura en la misma transacción. | El SQL de Claude no contiene CAS en WHERE; su garantía depende del indexer/bloqueo. Mantener una sola vía de escritura y demostrar interleavings antes de añadir otro escritor nativo. |

**Candidato de integración inmediato:** la implementación de Claude con su API index-store y el DDL observado, sujeto a resolver los acuerdos y a las pruebas de etapas 2/3. Es la implementación que consume hoy el Motor en desarrollo. El borrador de Codex permanece como diseño de evolución para árbol, cola durable y propiedades tipadas; sus 16 fixtures en memoria no acreditan ni migran el esquema distinto de Claude. No hay dos esquemas compatibles por llevar ambos el rótulo Base 3.

### Migración, búsqueda y permisos: límites concretos del snapshot

- index-store.js:144–169 importa el JSON legado al hacer load, llama saveScopeIndexToCatalog y después intenta eliminar el JSON. saveScopeIndexToCatalog eleva Base a 3 antes de escribir. Por tanto, una lectura mediante esa API puede migrar: esta auditoría leyó los archivos fuente y no llamó load. Para probar rollback se necesita copia íntegra y evidencia de migración; el marcador superior por sí solo sólo impide abrir con un Motor anterior.
- sqlite-catalog.js:121–145 configura WAL y synchronous=NORMAL al escribir, busy_timeout=5000 y abre/cierra DatabaseSync por operación. No es todavía una conexión única persistente ni incorpora garantía de Base en disco local. ensureSchema se invoca desde withCatalog; sólo las funciones saveScope* llaman prepareBaseFormat. marks-extractor.js:358 crea/escribe mediante withCatalog directamente. Acordar una barrera global única antes de toda primera escritura incompatible, también marcas y aliases cuando no haya habido saveScope* previo.
- groupMarksInCatalog ya existe en marks-extractor.js. Filtra scope_id en SQL antes de devolver filas y luego propiedad/grupo en memoria; no se observó todavía una llamada desde otro módulo src en la búsqueda de este snapshot. El llamador debe aportar sólo ámbitos con permiso leer vigente y revalidarlos frente a revocación; la función no puede considerar scope_id una autorización. La consulta no une cada marca con la identidad/generación actual de folder_entries. Las filas existentes, conteos y extractos deben quedar invalidados por cambio de archivo, permiso o regla.
- readMarkCandidateSafe:270–278 hace lstat de una ruta y después readFile de esa ruta. Esta secuencia no acredita lectura por el mismo handle, no protege ancestros intercambiados y no garantiza que el contenido conserve la identidad/huella del índice. Antes de conectar extracción a datos reales, usar el lector seguro del Motor/capacidad equivalente, con permiso leer y validación de identidad/fuente al publicar. No se atribuye a una herramienta publicada que aún no se observó conectada.
- La consulta actual puede leer todos los textos pendientes en la propia llamada y devolver todas las coincidencias; no se midió aquí el objetivo inferior a 1 s ni se observó una paginación de esa salida. Definir respuesta inmediata sobre snapshot/cobertura y extracción acotada en cola, o acreditar el presupuesto en fixtures grandes. Separar el costo de primera extracción del de agrupación caliente.
- Un snapshot completo de entradas reemplaza folder_entries, mientras que las marcas se limpian en la lógica de extracción o en actualización por rama. Definir invalidación transaccional de marcas obsoletas/ilegibles; no asumir que todas las rutas de actualización ya comparten la misma regla.

### Cliente Python actual y adaptación al IPC nativo

index-scan.js ahora arranca native_index.py con --daemon, reutiliza un proceso por ejecutable Python, serializa sus solicitudes y lo cierra tras 30 s de inactividad. Su solicitud es {root,maxEntries,exclude?,subpaths?}; espera {ok,records,issues,scannedPrefixes?,missingPrefixes?}. records contiene path, type, size, modifiedMs, changedMs, createdMs, identity y estados error/listing que se convierten a indexed/not-listed/unverified. Ese protocolo **no coincide** con scan v1 del piloto, que lista hijos inmediatos y devuelve {id,entries,complete,error?}.

Para integrar el ganador se necesita un adaptador explícito, no cambiar sólo pythonExecutable:

1. Conservar autorización, exclusiones, generación, cancelación, timeout y ciclo de vida del host. Encolar cada directorio y convertir name en path relativo sólo tras validar el segmento; no inventar fechas que scan v1 no entrega. Decidir extensión negociada para timestamps y metadatos necesarios por extracción. Con el v1 actual, no se acredita frescura de contenido por mtime si se omite ese dato.
2. Traducir complete=false a cobertura parcial y conservación de entradas previas; no enviar un directorio truncado a una mezcla que interpreta ausencias como bajas. Unir lotes/ramas sólo con identidad/generación vigente; un error de acceso conserva el último snapshot e informa su falta de verificación.
3. El DDL actual no guarda root_identity ni la identidad del directorio objetivo, y la solicitud/respuesta Python observada tampoco transmite expectedRootIdentity/rootIdentity. El observador rootIdentity es una comprobación separada por ruta, no una comparación sobre el mismo handle que enumera. El IPC v1 del piloto tiene igual límite de anclaje por ruta; esto no se presenta como regresión demostrada frente a r2.
4. Para trabajos durables ligados a objeto, acordar expectedRootIdentity y expectedDirectoryIdentity, y respuesta rootIdentity/directoryIdentity obtenidas del handle abierto, o una capacidad/handle equivalente. Comparar antes de enumerar y verificar generación al publicar. Se requieren ambas identidades cuando relative no está vacío; la raíz sola no protege una subcarpeta sustituida. Incorporar registro de identidad con migración y política explícita frente a reemplazos legítimos, sin convertir la identidad en permiso.
5. scan-v1.schema.json es estricto: esas extensiones no están implementadas ni se pueden añadir a peticiones dirigidas a un binario v1 sin negociar versión/capacidad. El adaptador y los schemas deberán congelarse juntos. Mientras tanto, los contratos MCP/rpc/health no cambian por adoptar SQLite o un nuevo escáner.

Cierre de esta alineación: se guardó el contraste y una extracción literal; no se corrigió ni ejecutó el DDL de ninguno de los dos candidatos. No se trasladó el catálogo, se migró la Base ni se sustituyó el escáner instalado. La aceptación de los acuerdos anteriores corresponde a la consolidación de etapas 4/5/6 antes de integración.

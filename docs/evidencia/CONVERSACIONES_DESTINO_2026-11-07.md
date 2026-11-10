# Memoria de conversaciones en archivos elegidos

El objetivo es conservar lo importante, redactado por el agente según las preferencias o por petición del usuario. Capturar el historial completo de las aplicaciones no es un requisito.

La herramienta conversacion_guardar escribe ahora un Markdown real en destino absoluto elegido (destino), conserva su ruta en el elemento (archivo) y actualiza el mismo archivo al retomar por ID y revisión. La preferencia general o por conversación puede definir carpeta_destino. Para una conversación nueva sin elección se usa Conversaciones dentro de la única carpeta abierta/autorizada con lectura y escritura. Los recursos multimedia pueden permanecer en otros destinos.

Se aplican las operaciones seguras existentes. Un archivo ajeno o editado externamente no se sobrescribe. Una ruta no concede acceso. El modo manual no crea carpetas ni registros sin petición expresa declarada. Si el archivo falla después de persistir continuidad, el estado pendiente_archivo informa la incidencia y no se comunica guardado completo.

## Evidencia de Codex real

Tres ejecuciones independientes y efímeras de Codex CLI 0.156.1, conectadas por MCP al motor en desarrollo y a la misma Base ficticia. No se pasó historial, ID ni ruta del archivo en los prompts de las siguientes conversaciones:

1. Guardó el acuerdo ficticio Brisa Cierre 7N: 23 cajas, viernes, pendiente confirmar transportista. Creó un Markdown bajo Conversaciones sin que el prompt especificara destino.
2. Buscó y leyó el acuerdo anterior, lo corrigió a 31 cajas, lunes y conservó el transportista como pendiente. Actualizó el mismo ID y archivo a revisión 2.
3. Recuperó el acuerdo vigente y la ruta correcta sin modificar ni guardar otro elemento.

Comprobación independiente en disco: un solo registro de conversación, revisión 2; el Markdown identifica 31 cajas y lunes como acuerdo vigente y señala explícitamente que sustituye el acuerdo anterior de 23 cajas para el viernes. Tiempos completos de modelo y herramientas: 33,96 s; 36,21 s; 21,60 s. No equivalen a la latencia del motor ni prueban rendimiento de otros agentes.

## Pruebas del incremento

test/conversation-destinations.test.js: tres pruebas aprobadas de destino predeterminado, archivo elegido, preferencias persistentes, continuidad con otra sesión/identidad MCP, corrección del mismo archivo, edición externa preservada, archivo ajeno preservado, modo manual y destinos no autorizados rechazados.

Las identidades MCP de las pruebas deterministas no son modelos reales de Claude o Gemini. La prueba real anterior de Antigravity pertenecía al experimento anterior y no valida automáticamente este incremento. No se afirma validación de todos los clientes.

La regresión completa se registra en el cierre. No se publicó una versión estable ni se sustituyó el motor de la instalación personal. El código está preparado para su revisión y posterior distribución conforme al algoritmo de publicación.

## Memoria y alcance

La revisión del consumo semántico detecta copias de pesos al verificar con readFile y construir Response desde buffers, además del vocabulario y la memoria WASM. La siguiente optimización a evaluar es lectura/verificación por flujo y entrega de pesos por streaming, manteniendo pesos, vectores y clasificación. No se modificó ni se afirma reducción de memoria en este cierre: el usuario priorizó terminar el guardado conversacional. La medición anterior de aproximadamente 1,1 GiB de pico sigue vigente para la variante semántica medida.

Cierre de validación: regresión completa ejecutada, 385 JavaScript (382 aprobadas, 2 omitidas, 1 fallo de temporización artificial de 100 ms en la prueba de recarga) y 51 Python (48 aprobadas, 3 omitidas). Se ajustó únicamente ese plazo de prueba a 2 segundos y se repitieron las 22 pruebas afectadas de conversaciones/destinos/preferencias/híbrida/runtime: todas aprobadas. El código de producción no cambió por ese ajuste.


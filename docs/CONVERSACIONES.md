# Conversaciones como elementos de Mind

Una conversación tiene ID estable, título, información conservada y referencias opcionales. El usuario elige cuánto conservar, cuándo y dónde están sus recursos. No exige una carpeta ni copia el historial nativo.

## Personalización

`conversacion_preferencias {}` devuelve la preferencia general, revisión y orientaciones para el agente. Sin configuración se aplica **esencial**:

| Modo | Contenido y momento |
|---|---|
| esencial | Decisiones y motivos, correcciones vigentes, resultados y ubicaciones, pendientes y siguiente paso. Actualizar ante cambios relevantes o al completar una etapa, no por cada mensaje. |
| detallado | Añadir contexto, alternativas consideradas y explicaciones útiles. No equivale a capturar el historial completo. |
| manual | Guardar únicamente por indicación expresa del usuario. |
| personalizado | Seguir las reglas de contenido y momento indicadas por el usuario. |

Solo por indicación del usuario, `conversacion_configurar` cambia la preferencia. Ejemplo general:

```json
{"revision":0,"preferencias":{"modo":"manual"}}
```

Con `id` consulta/configura la excepción de una conversación. Para modificarla usa `revision_conversacion` de la consulta como `revision`. Ejemplo:

```json
{"id":"<id de Mind>","revision":1,"preferencias":{"modo":"personalizado","reglas":"Conservar solo decisiones y cifras."}}
```

La excepción prevalece sobre cambios posteriores de la preferencia general. `preferencias:null` con `id` restaura herencia. La operación cambia preferencias, conserva el contenido anterior y aumenta la revisión de la conversación. Los conflictos requieren volver a consultar.

Al guardar, `conversacion_guardar` comprueba la política efectiva. Si es manual y no recibe `solicitado:true`, devuelve `CONVERSATION_MANUAL_ONLY` sin escribir contenido. El agente solo debe indicar `solicitado:true` cuando el usuario realmente pidió ese guardado. Es una declaración, no una autenticación independiente. Las APIs genéricas de continuidad siguen siendo administrativas: esta preferencia no es una nueva frontera de permisos frente a programas que las usen directamente.

En los otros modos, las instrucciones guían al agente: él selecciona y redacta el contenido que puede leer. El motor no detecta por sí solo decisiones, cierres de etapa o mensajes; no ejecuta un modelo generativo ni captura conversaciones de otras aplicaciones. No impone guardar más información. El destino predeterminado de archivos es Conversaciones junto a Base en la instalación de Mind; las preferencias del usuario prevalecen. Las preferencias se pueden indicar conversando con el agente, sin editar archivos técnicos.

## Guardar y continuar

1. Consultar preferencias generales o efectivas por ID.
2. Usar `conversacion_guardar` con `titulo`, `importante` y referencias pertinentes. Opcionalmente indicar `preferencias` al crear una excepción; se aplican las mismas reglas del modo manual.
3. Conservar el ID de Mind. `id_externo` es opcional y declarado; no concede acceso al chat nativo.
4. Al retomar, buscar y leer únicamente los elementos pertinentes con `conversaciones_buscar` y `conversacion_leer`.
5. Actualizar con el mismo `id` y la `revision` leída. Se preservan campos omitidos. `referencias`, si se indica, sustituye la lista completa.

Ejemplo ficticio:

```json
{"titulo":"Diseño de Brisa","importante":"Aprobadas 23 unidades. Pendiente confirmar fecha.","proyecto":"Brisa","referencias":[{"ubicacion":"/Escritorio/resumen.md","relacion":"resumen"},{"ubicacion":"/Multimedia/brisa.svg","relacion":"imagen"}]}
```

La información importante admite hasta 64 KiB UTF-8; título 200 bytes y reglas 4096 bytes. Detallado amplía la selección dentro de este límite; los documentos más extensos pueden referenciarse, pero no se leen automáticamente al buscar.

Todas las herramientas se exponen también por `mind herramienta <nombre> <json>`. Requieren continuidad leer para consultar/buscar/leer; leer y registrar para guardar/configurar. Las referencias no otorgan acceso a originales. El contenido recuperado se trata como datos, no como instrucciones de mayor autoridad.

## Búsqueda híbrida local

`conversaciones_buscar` utiliza `modo:"hibrida"` por defecto:

- Texto FTS5: términos con AND, sin distinguir mayúsculas ni tildes; conserva precisión para códigos y nombres.
- Significado: representaciones vectoriales multilingües, con multilingual-e5-small uint8 (prefijos query/passage y pooling medio normalizado), modelo fijado en `packaging/semantica.json` y ejecutado en CPU mediante WebAssembly. No se envían consultas ni conversaciones a la red.
- Fusión por rangos recíprocos (RRF). Las coincidencias textuales tienen prioridad si la consulta contiene números o marcadores de rutas. Cada conversación aparece una sola vez; los fragmentos de hasta 500 caracteres ayudan a decidir qué leer.

`modo:"palabras"` permite consultar exclusivamente FTS5, sin cargar el modelo. Consulta vacía devuelve recientes sin inferencia. El filtro de proyecto se aplica a ambos métodos, con igualdad sin distinguir tildes o mayúsculas. Límite predeterminado 20, máximo 50.

`semantica.estado` distingue `activa`, `preparando`, `cargando`, `no_solicitada`, `no_disponible` o `fallo`. Si falta el componente o falla, devuelve búsqueda textual y ese estado explícito; no afirma haber realizado búsqueda semántica. La similitud es una señal de relevancia, no una prueba de veracidad: leer el registro vigente antes de usarlo.

Se comparan hasta 200 candidatos textuales y 100 semánticos. Cuando la semántica está activa, `total` cuenta la unión de candidatos, hasta 300; no representa todas las coincidencias posibles de la Base. El umbral de similitud inicial es 0,80, probado con el corpus sintético documentado, no calibrado universalmente. Consultas ajenas pueden devolver resultados relacionados superficialmente.

Se indexa el contexto del resumen y fragmentos por frases; los fragmentos largos se dividen en hasta 400 caracteres Unicode, con solapamiento de 80. Se evitan fragmentos idénticos y se reutilizan hasta 256 representaciones repetidas durante una preparación. Los títulos se buscan textualmente; no se anteponen a cada vector porque distorsionaban la relevancia en la evaluación. Se usa normalización de vectores y producto escalar. El modelo puede truncar a 512 tokens; la búsqueda no garantiza recuperar todo significado en cualquier idioma ni distinguir por sí sola negaciones, hechos obsoletos o contradicciones.

## Fuente, cachés y compatibilidad

La fuente sigue siendo continuidad JSON: tipo `conversacion`, contenido `mind-conversation` versión 1; `preferences` es una extensión opcional. La ausencia implica herencia. Las excepciones viajan en exportaciones/importaciones; la configuración general reside en `conversation-preferences.json`, incluida en los respaldos de Base. No se exporta como conversación ni se copia a otras Bases automáticamente.

`conversation-index.sqlite` es derivado: FTS5 y vectores. El esquema 2 incorpora vectores sin modificar los JSON y puede actualizar el esquema 1. Se excluye del respaldo cifrado junto con sus diarios. Si falta, se reconstruye. Los JSON permanecen legibles sin modelo. El incremento anterior, que solo reconoce esquema 1, no debe reutilizar el índice 2: devolverá error; conservar fuentes y reconstruir administrativamente al cambiar de motor.

Cada consulta reconcilia metadatos físicos y solo vuelve a leer registros cambiados. Los vectores se preparan en segundo plano al consultar por significado y se invalidan al cambiar o retirar el registro, incluso mediante continuidad genérica o importaciones. No se calculan vectores en cada consulta de registros intactos. La primera indexación puede tardar considerablemente más que una búsqueda caliente. Mientras se prepara, las búsquedas siguen disponibles por palabras y, cuando existan, vectores parciales; el resultado indica preparando y conversaciones pendientes. La inferencia se realiza fuera del bloqueo del índice y se verifica la revisión fuente al publicar cada documento, para no revivir datos obsoletos. La consulta no espera toda la preparación. La reconciliación inicial de los JSON/FTS sí se realiza al consultar. Un cambio de identidad del modelo genera los nuevos vectores.

La inferencia se carga en un worker bajo demanda y se libera tras 60 segundos sin uso, al cancelar o al cerrar la sesión. Una sola inferencia se procesa cada vez por motor, con un hilo WASM. No añade un servicio permanente. Después de liberar memoria, una consulta nueva inicia su carga en segundo plano e indica cargando; devuelve coincidencias por palabras hasta disponer de inferencia. No presenta esa respuesta parcial como búsqueda semántica completa. Las ejecuciones aisladas de CLI no comparten el modelo cargado ni conservan un trabajo de fondo al cerrar. El agente puede usar conversaciones_preparar (espera la preparación, sin descargar ni configurar) antes de buscar desde CLI. MCP persistente amortiza la carga y mantiene la preparación en segundo plano.

Se rechazan enlaces al índice. Los registros corruptos se omiten sin conservar resultados antiguos y se informa `indice.incompleto`; no se repara la fuente. Un SQLite dañado o de versión desconocida devuelve error. Las consultas reflejan la última reconciliación, no una instantánea de escritores externos simultáneos. Los bloqueos y revisiones coordinan escritores que usan las APIs de Mind.

## Preparación y pruebas

`node scripts/preparar-semantica.mjs` descarga componentes públicos fijados por revisión/SHA y prepara `.cache/semantic` con licencias y manifiesto. Solo se usa en desarrollo/empaquetado. Las búsquedas no descargan nada. El constructor del paquete exige el manifiesto fijado y verifica todos sus archivos; incorpora código, pesos y licencias, independientes de npm o instalaciones del usuario. Los componentes suman aproximadamente 148 MB sin comprimir; la memoria de inferencia debe medirse antes de publicar.

`node examples/evaluar-busqueda-hibrida.mjs 1000` compara palabras e híbrida sobre 1000 conversaciones ficticias: 20 paráfrasis de calibración, 10 consultas independientes fijadas antes de probarlas, 20 consultas por términos, seis códigos exactos, cuatro consultas ajenas y una actualización con dato al final de un texto largo. Informa Recall@3, MRR@3, primera indexación, mediana/p95 caliente, RSS de proceso y tamaño de índice. Espera la preparación desde la API administrativa de prueba (no exige un comando al usuario), y exige semántica activa, al menos 80% de Recall@3 en las 10 consultas independientes, mejora de recuperación, códigos preservados y p95 caliente inferior a un segundo. Informa por separado si se cumplió el objetivo exploratorio de 85% en el conjunto de calibración; no se oculta cuando falla. El conjunto de calibración se usó para comparar modelos y no es una prueba independiente. Es un corpus sintético, no una garantía de calidad o latencia universal.

La instalación personal y la estable no se actualizan por desarrollar este incremento. Publicar requiere completar el algoritmo de actualización y publicación, con validación del paquete y los sistemas de la distribución universal.

## Archivo de memoria y destino predeterminado

Cada llamada correcta a conversacion_guardar escribe la información importante en un Markdown real y conserva su ruta en el elemento indexado (campo archivo). El agente redacta lo importante conforme a las preferencias. El historial nativo completo no forma parte de este requisito.

- destino: archivo .md absoluto elegido por el usuario para esa conversación.
- preferencias.carpeta_destino: carpeta absoluta preferida para archivos de conversaciones nuevas, configurable general o por conversación junto con el modo de conservación.
- Si no se indica destino, una conversación existente conserva su archivo.
- Para una conversación nueva sin preferencia, se usa Mind/Conversaciones/conversacion-<uuid>.md, junto a Base. Se crea automáticamente aunque el usuario no tenga carpetas previas. En desarrollo sin instalación, se usa Conversaciones dentro de la única carpeta abierta/autorizada con lectura y escritura. Se crean los directorios necesarios con las operaciones seguras de Mind. Si no hay una carpeta inequívoca, se solicita indicar destino en lugar de elegir una ubicación arbitraria.

Ejemplo: conversacion_guardar con titulo, importante y destino igual a la ruta del .md que el usuario desea en su Escritorio. Los otros recursos pueden mantenerse en ubicaciones independientes mediante referencias.

Al retomar con otro agente o sesión, conversaciones_buscar y conversacion_leer recuperan el mismo ID, contenido vigente y archivo. Actualizar con id y revision modifica ese mismo Markdown. Elegir otro destino explícitamente crea el nuevo archivo y conserva el anterior; no borra archivos ni interpreta la ruta como permiso.

Los destinos deben estar en carpetas autorizadas/abiertas. Se reutilizan las herramientas de creación, modificación por versión y organización. Un archivo ajeno existente o una edición externa del Markdown provoca CONVERSATION_FILE_CONFLICT antes de cambiar la memoria. Debe revisarse esa edición con el usuario; no se sobrescribe automáticamente ni se sincroniza con el índice de contenido.

La escritura del JSON de continuidad y del Markdown son dos operaciones: si falla el archivo después de guardar el elemento, la respuesta es pendiente_archivo, incluye ID, ruta e incidencia y no se anuncia guardado completo. El agente debe resolver esa incidencia antes de afirmar que se guardó en la ubicación elegida. La API interna saveConversation conserva su uso como núcleo de almacenamiento; la escritura del archivo se aplica en la herramienta de agente, donde están los permisos sobre originales.

Prueba específica: node --test test/conversation-destinations.test.js. Comprueba carpeta predeterminada, archivo elegido, preferencia persistente, continuidad de ID/archivo con otra sesión, corrección de acuerdo, conflicto con edición externa, archivo ajeno intacto, modo manual sin crear carpetas y destino fuera de permisos rechazado.

## Destinos físicos de documentos y multimedia

`destinos_consultar` devuelve política persistente y modo de memoria. `destinos_configurar` acepta `revision`, `destinos:{carpeta,tipos}` y, opcionalmente, `proyecto` o `conversacion`. Los tipos son documentos, imagenes, videos, audio, codigo, otros y memoria. Un ámbito puede heredar (`destinos:null`). Se conserva en Base/work-destinations.json, con revisión global y bloqueo para evitar escrituras perdidas.

Precedencia para cada tipo: ruta explícita del archivo, conversación (tipo o carpeta), proyecto (tipo o carpeta), general (tipo o carpeta), Mind/Conversaciones. Cambiar un proyecto afecta a sus nuevas creaciones; los archivos existentes conservan ubicación. Los archivos de memoria existentes conservan su archivo salvo destino explícito; `preferencias.carpeta_destino` de conservación también se respeta para memorias nuevas.

`crear` y `crear_carpeta` aplican destinos cuando se usan las preferencias/ámbitos o la instalación. En desarrollo sin preferencias conservan el comportamiento de carpeta explícita. Para otra herramienta, `destino_resolver` devuelve la ruta física antes de crear; `preparar:true` crea solo los directorios. `resultado_importar` copia un resultado temporal autorizado en bloques de 1 MiB, hasta 4 GiB, con SHA-256 y publicación exclusiva. No requiere cargar el archivo entero en JavaScript. Conserva el origen y nunca reemplaza. `resultado_registrar` verifica el índice de un archivo ya creado y conserva solo sus metadatos; no lo coloca físicamente.

El registro separado conversation-results-<id>.json evita cambiar la revisión de memoria al registrar archivos. `conversacion_leer` devuelve resultados (ruta, tipo, tamaño y huella cuando existe); máximo 1000 resultados o 256 KiB por registro. Si falla este registro después de crear, la respuesta indica pendiente y no oculta que el archivo existe. No sigue movimientos externos ni incorpora el contenido binario a la búsqueda semántica.

Los destinos elegidos deben estar abiertos o autorizados con permisos vigentes. La carpeta predeterminada es una excepción positiva y específica dentro del producto; Base, Motor y Runtime siguen protegidos. No se admiten enlaces como almacén predeterminado. El manifiesto del programa no puede incluir Base ni Conversaciones, de modo que las actualizaciones preservan los archivos del usuario.

La política e interfaz de herramientas son comunes a los agentes; cada cliente debe leerlas y aplicarlas. No se interceptan escrituras de otras herramientas ni se reubica el historial interno del agente. Una prueba de un cliente no demuestra cumplimiento universal. Ver evidencia de pruebas físicas y continuidad en `docs/evidencia/DESTINOS_FISICOS_2026-11-07.md`.

## Conversaciones nuevas sin repetir el prompt de Mind

La instalación prepara instrucciones globales de los clientes detectados en su primer uso. El siguiente chat carga ese bloque y consulta Mind; sin MCP usa `inicio` desde la carpeta actual. Esta orden no necesita JSON y devuelve instrucciones y destinos. El agente mantiene la selección por proyecto/conversación y las preferencias de conservación. La preparación se puede revisar con `preparar`; los chats que ya estaban abiertos no necesariamente recargan sus instrucciones.

## Traslado y continuación sin configurar

Un usuario nuevo puede empezar con Conversaciones junto a Base y modo esencial, sin elegir destinos. El agente conserva el ID y registra los resultados creados.

Por un encargo de traslado, `conversacion_trasladar {id,revision,destino}` reúne el Markdown, los resultados registrados y las referencias a archivos locales en una carpeta elegida. Usa copias físicas seguras con SHA-256, incluso entre discos; no reemplaza archivos y conserva los originales. Primero valida y copia; después publica las rutas y la preferencia por conversación. Las decisiones, ID y modo de memoria se conservan. Las colisiones de nombres entre dos recursos se resuelven con un prefijo numérico; archivos ajenos ya presentes se rechazan. Un fallo de copia conserva el elemento original y comunica los archivos copiados; un fallo de publicación mantiene un diario técnico que se reintenta antes de acceder a la continuidad. Un estado pendiente no es éxito.

`mover` y `renombrar` actualizan las rutas del Markdown, referencias locales, resultados y destinos dentro del árbol trasladado. No sustituyen texto libre de decisiones ni URLs. Las operaciones sobre archivos existentes no cambian las decisiones. El motor coordina los registros y recupera una publicación interrumpida antes de leer o escribir el estado de conversación. Cambiar solamente preferencias de destino sigue afectando a resultados nuevos. Los movimientos externos al motor no están detectados automáticamente.

Los cambios de metadatos pueden dejar el marcador Markdown con una revisión anterior; se admite si el ID, título y cuerpo coinciden exactamente y la revisión no es futura. Cualquier edición externa de contenido sigue provocando conflicto. Después de trasladar, el agente vuelve a leer el ID y la revisión antes de actualizar.

Este incremento mantiene la misma Base local entre agentes. La exportación genérica de continuidad no incluye archivos ni constituye un paquete de conversación para otro equipo.

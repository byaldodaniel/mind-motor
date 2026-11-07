# Personalización y búsqueda híbrida — evidencia local

## Alcance

Incremento de conversaciones del PR #26. Conservación esencial por defecto; general y excepción por conversación; modos detallado, manual y personalizado. La herramienta de guardado rechaza contenido automático en manual. El agente redacta el resumen conforme a las preferencias; el motor no captura conversaciones nativas ni genera resúmenes por sí solo.

La búsqueda añade multilingual-e5-small uint8, CPU/WASM y FTS5 con fusión RRF. El programa incorpora pesos y licencias verificados. Las consultas no descargan componentes ni envían información fuera del equipo.

Se compararon modelos con el corpus de calibración. La variante final conserva contexto y fragmentos por frases, usa los prefijos query/passage de E5 y normaliza vectores. La referencia fp32 y la cuantización alternativa ayudaron a diagnosticar la pérdida de calidad de las primeras variantes. Los primeros resultados fallidos no se consideran validaciones aprobadas.

## Evaluación con modelo real

Windows x64, Node 24.18.0, equipo de 12 GB de RAM. Comando reproducible: `node examples/evaluar-busqueda-hibrida.mjs 1000`. Base temporal, 1000 conversaciones ficticias; no se usó la instalación personal.

| Comprobación | Palabras | Híbrida preparada |
|---|---:|---:|
| 20 preguntas reformuladas usadas para calibrar, Recall@3 | 0/20 | 15/20 |
| 10 preguntas independientes fijadas antes de ejecutarlas, Recall@3 | 0/10 | 8/10 |
| Seis códigos exactos, primer resultado | 6/6 | 6/6 |
| Consultas por términos seleccionados, Recall@3 | — | 20/20 |
| Cuatro preguntas ajenas, devoluciones sin coincidencias | — | 4/4 |
| Mediana caliente | 91 ms | 141,40 ms |
| Percentil 95 caliente | 92,11 ms | 148,52 ms |

La comparación por preguntas completas usa el comportamiento textual anterior (todos los términos con AND). No demuestra que un agente que reformule o elija términos no pueda encontrar por palabras: las consultas por términos seleccionados sí recuperan los veinte casos. La mejora permite que más preguntas reformuladas funcionen directamente.

El objetivo exploratorio de 85% en calibración **no se alcanzó**: obtuvo 75%. No se presenta ese conjunto usado para ajuste como prueba independiente. El conjunto separado obtuvo 80% y cumplió el umbral fijado antes de su primera ejecución. Son muestras pequeñas y sintéticas; no garantizan calidad para cualquier conversación. Las dos consultas independientes fallidas fueron plantas y traducción, desplazadas por registros relacionados superficialmente.

Se verificaron actualización del código (el anterior desaparece de la búsqueda textual), incorporación del nuevo y recuperación de una cita situada al final de un resumen largo. Los registros intactos no vuelven a leerse ni a vectorizarse en consultas calientes.

## Arranque y preparación

| Medida | Resultado |
|---|---:|
| Primera reconciliación JSON/FTS de 1000 registros | 1.786 ms |
| Primera consulta híbrida con FTS ya reconciliado | 238 ms, estado preparando |
| Preparación completa de vectores en segundo plano | 88,47 s |
| Búsqueda por palabras durante preparación, mediana/p95 (5 muestras) | 144,47 / 317,09 ms |
| Consulta del dato cambiado tras preparar | 195,19 ms |
| Preparación incremental del resumen largo cambiado | 2,20 s |

El tiempo de preparación no es tiempo de respuesta semántica completa. Durante ella, las búsquedas devuelven palabras y vectores parciales con estado y número de conversaciones pendientes. La inferencia no retiene el bloqueo mientras calcula. Se verifica la revisión original al publicar para evitar resultados obsoletos.

Tras 60 segundos sin uso, el worker libera el modelo. Una nueva consulta inicia su carga en segundo plano y devuelve estado cargando y coincidencias textuales. La prueba del runtime real verifica que esa consulta no espere la recarga y que, una vez preparada, recupere el elemento correcto. En CLI se puede esperar la preparación con `conversaciones_preparar`; los procesos aislados no comparten el modelo cargado.

## Recursos

- Componentes semánticos preparados: 147.775.534 bytes sin comprimir (aprox. 140,9 MiB).
- Índice derivado del corpus: 6.877.184 bytes.
- RSS del proceso completo: 44,29 MiB al comenzar, pico 1.100,02 MiB durante el ensayo y 285,48 MiB tras terminar el worker. Incluye todo el proceso, sus buffers y SQLite; no es una medida de memoria exclusiva del modelo ni demuestra liberación inmediata de todas las páginas al sistema.
- Un hilo WASM; sin servicio permanente. El consumo de aproximadamente 1,1 GiB en el pico es un coste material de esta variante. No se extrapola a equipos con menos memoria.

## Validación funcional y límites de entrega

Pruebas específicas: preferencias y revisiones concurrentes; manual y petición expresa; herencia, excepciones y exportación/importación; permisos; invalidación de vectores; modelo cambiado; degradación explícita; códigos exactos; no bloqueo durante inferencia; revisión obsoleta descartada; runtime real trasladado y offline; descarga/recarga sin bloquear; integridad de componentes alterados. Las pruebas deterministas de índice usan dobles; la evaluación de calidad y el runtime trasladado usan pesos reales.

La regresión completa se registra en el informe de cierre y el PR. La variante final de respuesta caliente y preparación se midió antes de la corrección de dos carreras de cierre/recarga y bloqueo transitorio de Windows; esas rutas se comprobaron después con las pruebas afectadas y la suite final. Esas correcciones no cambian el modelo, umbral, contenido de vectores o algoritmo de clasificación.

No se generó una distribución estable, no se actualizó My Mind y no se probó inferencia en macOS/Linux ni todos los clientes. El empaquetador verifica e incluye el bundle semántico; la prueba de traslado verifica ese conjunto en Windows, sin ser una prueba del ZIP universal completo. Publicar sigue requiriendo el algoritmo de actualización, la matriz de plataformas y la comprobación del paquete final.

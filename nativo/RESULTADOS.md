# Resultados — piloto nativo Mind 1.0.4-r3, Etapa 5

16 de noviembre de 2026. Codex. Piloto aislado en Borradores/Piloto-Nativo-r3, para revisar con Aldo en Gemini.

## Decisión

**Rust gana el piloto por memoria y tamaño y es mi recomendación para continuar la pieza nativa.** Ambos candidatos superaron los trece casos funcionales comunes. El puente Rust usa unas 39.8 veces menos memoria privada medida y el ejecutable es 4.8 veces menor. Go generó los seis destinos completos y se conserva como alternativa.

La distribución universal Rust sigue condicionada a completar tres destinos con sus SDKs. Elegirlo para continuar no equivale a publicar una versión universal ya cerrada. Si esa puerta no se supera, debe reconsiderarse Go con su coste de memoria explícito.

El componente contiene bridge y scan; no es el Motor completo ni sustituye todas las operaciones Python. Un puente stdio sigue siendo un proceso. El objetivo de un residente con HTTP directo pertenece a las etapas del constructor.

## Mediciones finales Windows x64

| Medida | Rust | Go |
|---|---:|---:|
| Binario Windows x64 (MiB) | 1.43 | 6.93 |
| Puente: privada en reposo, mediana (MiB) | 1.16 | 46.33 |
| Puente: RSS en reposo, mediana (MiB) | 4.56 | 9.12 |
| Puente persistente, p50 / p95 (ms) | 1.19 / 2.01 | 1.25 / 2.67 |
| Puente proceso nuevo, p50 / p95 (ms) | 75.45 / 495.14 | 67.01 / 414.85 |
| Escáner: privada en reposo, mediana (MiB) | 1.03 | 46.29 |
| Escáner: RSS en reposo, mediana (MiB) | 3.61 | 8.21 |
| Escáner persistente, p50 / p95 (ms) | 3.67 / 4.79 | 2.82 / 20.24 |
| Escáner proceso nuevo, p50 / p95 (ms) | 42.18 / 61.36 | 49.56 / 179.53 |

MiB = 1.048.576 bytes. Privada corresponde a PrivateMemorySize64; RSS a WorkingSet64: no se suman ni significan lo mismo. Se registraron 0 ms adicionales de CPU en las dos ventanas de reposo por modo; el contador y la ventana corta no acreditan 0% sostenido.

Go tuvo menor mediana de escaneo; Rust menor p95 en la muestra definitiva. Hubo variación entre rondas. No atribuyo los outliers a un defecto del lenguaje ni uso estas cifras para prometer velocidad de indexación global.

## Método y reproducibilidad

Equipo: Intel(R) Core(TM) i7-7500U CPU @ 2.70GHz, 4 procesadores lógicos, 12188.22 MiB RAM, Windows x64. Harness Node v24.18.0. Go 1.27.4 con CGO_ENABLED=0, trimpath y stripping; Rust 1.100.0 GNU con opt-level=s, LTO thin, stripping y panic=abort. Descargas oficiales verificadas por SHA-256, toolchains portátiles dentro del piloto; no van en el producto.

Cuatro rondas finales Go/Rust/Rust/Go, sin compiladores propios activos. Por lenguaje: 30 procesos nuevos por modo, 1.200 herramientas secuenciales por puente persistente, 600 listados de un directorio de 256 archivos y diez muestras de memoria por modo. Hubo calentamiento previo. Percentiles por rango más próximo.

El arranque del puente incluye proceso, descubrimiento, initialize y primera herramienta. Proceso nuevo no implica caché de disco/SO vacía. El servidor de rendimiento devuelve eco y no consulta SQLite; el escaneo incluye IPC y serialización. La prueba funcional Unicode sí ejecutó un Motor r2 congelado con Base ficticia.

La PC mantuvo su actividad ordinaria; no es una sesión de laboratorio sin otras aplicaciones. Los datos de macOS/Linux/ARM64 son sólo de compilación: no se inventaron métricas de memoria ni latencia para esos sistemas. Ninguna cifra es garantía de carga sostenida.

Muestras completas: evidence/go-1-metrics.json, go-2-metrics.json, rust-1-metrics.json y rust-2-metrics.json. Consolidado: evidence/metrics-summary.json. No se quitaron outliers. Un primer ensayo Rust carecía de un argumento obligatorio, falló sin generar métricas y quedó en rust-measure-invalid-cli.log; se corrigió la CLI del harness para ambos y se repitieron las rondas definitivas sobre los hashes finales.

## Compilación cruzada

| Destino | Go: bytes / resultado | Rust: bytes / resultado | Ejecución |
|---|---:|---:|---|
| win32-x64 | 7265280 / completo | 1501696 / completo | Ambos |
| win32-arm64 | 6583808 / completo | sin binario / probe SDK falló | Pendiente |
| linux-x64 | 7041184 / completo | 1772368 / completo | Pendiente |
| linux-arm64 | 6488224 / completo | 1592816 / completo | Pendiente |
| darwin-x64 | 7179648 / completo | sin binario / probe SDK falló | Pendiente |
| darwin-arm64 | 6657442 / completo | sin binario / probe SDK falló | Pendiente |

Go produjo seis builds completos enlazados. Evidencia de código de salida, tiempo, tamaño y SHA-256: go/evidence/crossbuild.json. Rust produjo tres builds completos; se instalaron las bibliotecas estándar para los seis destinos.

En macOS x64/ARM64 un probe mínimo con std y enlazador reales falló: xcrun/SDK ausente y bibliotecas System/c/m no encontradas. En Windows ARM64 MSVC faltaron kernel32.lib, ntdll.lib y otras import libraries del SDK. Son probes de enlace, no builds completos del puente. Un build macOS x64 comenzó y se interrumpió al acreditar el SDK faltante; no figura como fallo completo del código. Matriz y comandos: rust/evidence/matrix.json y sdk-probes.json.

La primera dificultad del host Rust con dlltool se resolvió usando llvm-dlltool oficial dentro del piloto. No se instalaron SDKs globales. Véanse [Apple Darwin](https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html) y [Windows MSVC](https://doc.rust-lang.org/rustc/platform-support/windows-msvc.html): los bloqueos locales no prueban inviabilidad del lenguaje.

Las cabeceras PE/ELF/Mach-O se inspeccionaron en evidence/binary-formats.json. Compilación y cabecera correctas no equivalen a ejecución funcional. En Windows los binarios no importan un runtime de lenguaje externo: estas dos piezas no requieren instalar Node/Python, pero el Motor central r3 todavía los conserva.

## Pruebas

- 13/13 casos comunes en cada candidato final: ocho originales r2 más salud HMAC falsa, SSE Unicode fragmentado, IDs inválidos, scanner adversario y relevo que muere tras recibir una escritura.
- Los ocho originales conservan nombres y 49 líneas de aserciones: evidence/bridge-test-provenance.json. La adaptación cambia transporte, imports y temporales aislados.
- Escáner: Unicode/NFD, vacío, límites, traversal, junctions y 100 consultas durante intercambio concurrente de un directorio con un junction. No lee contenido de documentos.
- Go final: evidence/go-final.tap (13) y go/evidence/unit-tests.txt (10 propias); go vet correcto. Rust: rust-final.tap (12) más rust-relay-death.tap (1), mismo hash final.
- 16/16 fixtures del SQL propuesto en SQLite en memoria. Validan integridad, tipos, idempotencia y filtrado de ámbito/generación/identidad; no migración real 2→3, rollback ni ACL de producción.
- REVIEW.md conserva hallazgos durante construcción. Los IDs y la muerte del relevo ya se corrigieron y pasaron las pruebas finales; no tratarlos como fallos actuales sólo por aparecer en la revisión inicial.

## Contratos y concordancia con Claude

CONTRATOS.md documenta /mcp, /rpc, /health y scan-v1 con schemas. Durante el piloto Claude añadió Base 3 y catalog.sqlite. La sección 9 conserva un mapeo y contracts/base-v3.claude-observed.sql guarda su DDL literal con fecha/hashes.

**El SQL observado y base-v3.draft.sql son distintos.** Para integrar se toma la API/esquema de Claude como candidato inmediato; el borrador Codex queda como evolución, no como instalador ni migración aplicable. Antes de congelar el contrato deben conciliarse versionado SQL, propiedades arbitrarias, cola durable, invalidación de marcas y apertura segura de contenido.

El daemon Python actual acepta subpaths y devuelve registros con fechas; scan-v1 lista hijos inmediatos y no es un reemplazo directo. INTEGRACION.md detalla adaptador, fechas, identidades de raíz/directorio, validación de generación, lotes para directorios grandes y admisión. No se modificó el código concurrente para imponer estos acuerdos.

## Artefactos y continuación

dist/winner/manifest.json registra Rust como seleccionado y la distribución universal como pendiente. Incluye copias verificadas de Windows x64 (ejecutado, probado y medido), Linux x64 y Linux ARM64 (enlazados, no ejecutados). Go/bin conserva la alternativa completa de seis destinos. Las fuentes y build.ps1 de ambos están disponibles.

README.md orienta la revisión; CONTRATOS.md, REVIEW.md e INTEGRACION.md contienen contratos y puertas. reference/motor-r2 congela b33dfd9735b8ce535c5273dac7390e3fddf21a54 para reproducir las pruebas. Los toolchains/caches son herramientas del piloto, no contenido del ZIP de Mind.

No se modificaron Motor/src, configuración MCP real ni My Mind/Sistema/Base. El único resultado externo al piloto es el registro solicitado en el Frente. Queda para integración: completar SDKs y ejecución por plataforma, conciliar/adaptar los contratos con Claude, probar la migración aislada y el conjunto Motor+auxiliar+clientes antes de publicar.

## Contexto del cierre concurrente

Al registrar el resultado de Etapa 5, el Frente ya incluía un cierre de Gemini que informa construcción y aplicación local de etapas 0–4 (commit f0ba3c8), Base personal 3 y cliente Antigravity configurado. Se conservó ese registro sin sobrescribirlo; no se revalidó desde este piloto ni se ejecutó otra migración. La alineación SQL de CONTRATOS.md sigue identificada por su snapshot y hashes, no por una suposición de que todos los archivos posteriores sean iguales. Antes de integrar, contrastar con la rama/estado vigente y no aplicar el SQL borrador sobre la Base existente.
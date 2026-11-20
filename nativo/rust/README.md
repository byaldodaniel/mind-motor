# Candidato Rust — piloto nativo de Mind r3

Piloto aislado. No sustituye el Motor ni cambia la Base personal. El ejecutable contiene dos modos: puente MCP stdio–HTTP y enumeración segura de un directorio por petición JSONL. No incluye los runtimes completos de Node ni Python. El compilador, sus archivos y las dependencias de construcción se guardan aparte en `../toolchains/rust`; no forman parte del ejecutable distribuible.

## Construcción reproducible

Toolchain: Rust 1.100.0 para Windows GNU, descargado de `static.rust-lang.org`; hashes SHA-256 contrastados con `channel-rust-stable.toml`. Dependencias fijadas en `Cargo.lock`. Se emplea `rust-lld` y el modo `llvm-dlltool` del `llvm-ar` oficial. El intento GNU inicial falló porque `dlltool` intentaba lanzar un ensamblador ausente: la evidencia se conserva en `build-windows.log`. No se instalaron compiladores ni SDK globales.

Desde PowerShell:

```powershell
& .\build.ps1
& .\build.ps1 -Target x86_64-unknown-linux-musl
```

El script limita Cargo a dos trabajos y fija `CARGO_HOME`, `RUSTUP_HOME`, `CARGO_TARGET_DIR`, `TEMP` y `TMP` dentro del piloto. La configuración `.cargo/config.toml` contiene rutas del toolchain de este equipo: debe regenerarse al trasladar el entorno de construcción. El primer intento de compilación heredó TEMP/TMP; las compilaciones posteriores los acotan expresamente.

El ejecutable Windows está en `target/release/mind-native-rust-pilot.exe`. Los demás destinos se generan en `target/<triple>/release/`. `evidence/crossbuild.json` y los logs por destino registran el intento completo de compilación y enlace, su código de salida, duración y huella del artefacto cuando existe. Una compilación cruzada no acredita ejecución en ese sistema.

## Interfaz

```text
mind-native-rust-pilot.exe bridge --base ABS --cwd ABS --paths JSON --launch-command ABS [--launch-arg ARG ...]
mind-native-rust-pilot.exe scan
```

Opciones adicionales del puente: `--motor-version`, `--package-revision`, `--relaunch-command` y `--relaunch-arg` repetible. El comando de lanzamiento se recibe explícitamente; no se busca, instala ni configura un cliente del equipo.

Ejemplo de petición del scanner:

```json
{"id":"lote-1","root":"C:\\Pruebas","relative":"Documentos","maxEntries":1000}
```

Responde con `id`, `entries` y `complete`; un fallo incluye `error.code` y `error.message`. Sólo enumera el directorio indicado. El valor predeterminado es 100.000 entradas; el máximo aceptado es 1.000.000. El límite efectivo de respuesta es 16 MiB: al alcanzarlo devuelve `complete:false`. No hay un cursor persistente todavía.

## Garantías implementadas

- El puente verifica la identidad de la Base y HMAC de `/health` antes de enviar el secreto. Sólo conecta a `127.0.0.1`; no usa proxies ni sigue redirecciones. La lectura de salud está limitada a 64 KiB durante el flujo.
- El ámbito del cliente viaja como Base64URL sólo en `initialize`. La notificación `initialized` actúa como barrera; SSE conserva Unicode fragmentado y permite responder peticiones del servidor concurrentemente.
- Una escritura cuyo resultado se perdió no se repite. Lecturas repetibles y rechazos explícitos tienen reintentos acotados. `ping` responde localmente sin despertar al Motor. Los fallos iniciales ofrecen `estado` y notifican el cambio de herramientas al recuperarse.
- El relevo por revisión abre el programa indicado e inicializa su sesión. Las llamadas pendientes reciben un error explícito si el hijo termina; una escritura no se repite por esa causa. Entrada, respuesta HTTP y eventos SSE tienen límites de memoria por mensaje.
- Windows usa `NtCreateFile` con `RootDirectory`, un componente por apertura, `FILE_OPEN_REPARSE_POINT` y comprobación del mismo handle. Enumera ese handle con `GetFileInformationByHandleEx`; nunca vuelve a abrir por una ruta completa comprobada previamente.
- POSIX usa `openat` con `O_NOFOLLOW|O_DIRECTORY` y `fstatat` sin seguir enlaces. Rechaza cambios de volumen al descender desde la raíz. No modifica los originales.
- Las rutas relativas rechazan `..`, `.`, barras invertidas, dos puntos, componentes vacíos y barra final. Unicode inválido provoca un error explícito, sin sustitución de nombres. Identidades: `nt:<volumen>:<id>` o `posix:<dispositivo>:<inodo>`.

La Base del conector se supone privada y de confianza; su apertura protege el archivo final frente a enlaces. La protección de todos los componentes corresponde al scanner, no a la lectura de descubrimiento del conector.

## Comprobaciones y límites

Root verificó el binario Windows con las doce pruebas comunes del piloto: ocho de compatibilidad, dos de frontera, una de scanner y una de IDs inválidos. Las evidencias definitivas y mediciones comparadas son las del directorio `../evidence` y conservan la huella del ejecutable.

El scanner trata conservadoramente toda entrada Windows con atributo reparse como `link`; no distingue todavía todas las variantes de archivos de nube. Sólo se ha ejecutado físicamente en Windows x64. Falta validar cada plataforma real, comprobar identidad esperada al retomar jobs, añadir cursor y cola persistente, permisos del anfitrión, catálogo transaccional, agrupaciones y actualización del producto. Este piloto no acredita un único proceso total de Mind: el modo puente sigue siendo un proceso por cliente stdio.

## Resultado de la matriz

`evidence/matrix.json` distingue tres binarios completos de tres pruebas mínimas de enlace que fallaron por SDK:

| Destino | Resultado |
|---|---|
| Windows x64 GNU | Puente y scanner completos; ejecutado y medido. |
| Linux x64 musl | Puente y scanner completos, 1.772.368 bytes; no ejecutado. |
| Linux ARM64 musl | Puente y scanner completos, 1.592.816 bytes; no ejecutado. |
| macOS x64 | Prueba mínima de enlace falló por MacOSX SDK ausente. El build completo comenzó y se interrumpió al acreditar ese bloqueo; no se registra como fallo completo del puente. |
| macOS ARM64 | Prueba mínima de enlace falló por MacOSX SDK ausente. No se construyó el puente completo. |
| Windows ARM64 MSVC | Prueba mínima de enlace falló por bibliotecas del SDK ausentes. No se construyó el puente completo. |

Los seis targets tienen su biblioteca estándar oficial instalada. El bloqueo de los últimos tres no es una inferencia por falta de `rust-std`: los logs contienen los errores reales del enlazador. No se instalaron SDK globales ni se afirmó ejecución cruzada. Referencias de plataforma: https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html y https://doc.rust-lang.org/rustc/platform-support/windows-msvc.html.

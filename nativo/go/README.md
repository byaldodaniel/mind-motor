# Candidato Go — piloto nativo Mind 1.0.4-r3

Este directorio es un piloto aislado; no sustituye el Motor instalado ni administra permisos, indexación o actualizaciones. El ejecutable contiene dos modos: puente MCP stdio/HTTP y escáner persistente de un directorio por petición.

## Compilación y dependencias

Ejecutar `.\build.ps1 -Cross` desde este directorio. Usa el compilador portátil oficial situado en `..\toolchains\go\go`, Go 1.27.4, descargado de https://go.dev/dl/ y verificado por SHA-256 contra sus metadatos oficiales. ZIP Windows amd64: `178ab98950ac69ab25069307dc6ade79f3816e414cce95b4da166a115cde1e7e`.

Todo el caché, los temporales de pruebas y los binarios quedan dentro de este piloto. Compila con `CGO_ENABLED=0`, `GOMAXPROCS=2` y `-p 2`; no instala programas globalmente. Los destinos son Windows, Linux y macOS, cada uno amd64 y arm64. Compilar no demuestra ejecución en esos equipos: aquí sólo se ejecuta Windows amd64.

Dependencias oficiales fijadas y verificables en go.mod/go.sum:

- golang.org/x/text v0.30.0: normalización NFC del identificador de Base.
- golang.org/x/sys v0.37.0: wrappers POSIX openat/fstatat. Windows usa llamadas nativas mediante syscall/unsafe, incluidas en biblioteca estándar.

Los módulos y el runtime mínimo compilado de Go van dentro de cada ejecutable; el usuario final no necesita instalar Go, Node ni Python para estos dos modos. El compilador portátil es una herramienta de construcción, no un componente de distribución del candidato.

## CLI

```text
mind-native-go bridge --base ABS --cwd ABS --paths '["ABS"]'
  [--launch-command ABS --launch-arg ARG ...]
  [--relaunch-command ABS --relaunch-arg ARG ...]
  [--motor-version 1.0.4 --package-revision 2]

mind-native-go scan

```

Los argumentos de lanzamiento se ejecutan exactamente como se proporcionan, sin shell ni concatenación de comandos. El anfitrión es responsable de suministrar un lanzador confiable y una Base autorizada. El puente no prepara configuraciones, no escribe la Base, no descarga programas ni inicia otro motor si el actual acredita su identidad.

## Puente

- Verifica Base canónica/NFC, puerto y prueba HMAC de /health antes de enviar el secreto.
- Lee conector y secreto por handles no-follow, componente a componente; deniega enlaces/reparse y archivos no regulares. No usa la secuencia lstat/abrir de nuevo para leerlos.
- Sólo envía X-Mind-Workspace durante initialize, codificado base64url UTF-8.
- Ordena initialize/notifications/initialized; procesa herramientas en paralelo para no bloquear respuestas del cliente a roots/list o elicitation.
- Soporta SSE tanto en POST como en GET y reenvía peticiones del servidor al cliente.
- Conserva estado reducido (estado) y notifica tools/list_changed cuando recupera conexión.
- Reintenta una vez un rechazo explícito 401/404/503; una escritura cuya conexión se pierde después de conectarse no se repite; las lecturas conocidas se pueden repetir una vez.
- ping no despierta un motor apagado.
- Un cambio de versión o revisión puede ceder al puente instalado mediante el relanzador explícito. El proceso padre permanece como relevo; esto no cumple aún la promesa de un proceso total.

Límites del piloto: no implementa presencia en Sistema/Estado, integración WMI/Job Objects ni transacción de actualización; la independencia del motor lanzado respecto del cliente Windows debe resolverse en el producto. El protocolo stdio del piloto admite un objeto JSON-RPC por línea, no lotes de objetos. Una caída SSE se recupera al siguiente uso real mediante una sesión nueva, sin despertar en bucle al motor. No es un servidor MCP autónomo ni reemplaza el Motor completo. No se añade un nuevo watchdog residente.

## Escáner

Entrada y salida JSONL persistentes según ../contracts/scan-v1.schema.json. Una petición lista un único directorio:

```json
{"id":1,"root":"C:\\fixture\\root","relative":"sub","maxEntries":100000}

```

id acepta entero seguro no negativo o texto no vacío de hasta 128 caracteres. maxEntries omitido usa 100000, explícito debe estar entre 1 y 1000000. relative usa componentes separados por /; rechaza rutas absolutas, segmentos . y .., componentes vacíos, dos puntos y barra inversa. Los frames tienen un límite de 16 MiB. Una respuesta demasiado grande produce error y complete=false; no anuncia un listado completo.

Windows abre desde una unidad local fija con letra, usando NtCreateFile con RootDirectory y FILE_OPEN_REPARSE_POINT para cada componente; verifica atributos del handle y enumera mediante GetFileInformationByHandleEx sobre ese mismo handle. Rechaza UNC, dispositivos, unidades no fijas y cualquier directorio reparse. Identidades nt:volumen:fileId; si fileId es cero, omite identity. Clasifica las entradas reparse como link y no las atraviesa. Rechaza nombres UTF-16 con surrogates sueltos.

Linux/macOS abre / y luego cada componente mediante openat con O_DIRECTORY|O_NOFOLLOW; enumera nombres del descriptor y toma metadatos con fstatat(AT_SYMLINK_NOFOLLOW). Identidades posix:dev:ino. Rechaza nombres que no se puedan representar exactamente como UTF-8. Un fallo de stat que no sea desaparición produce complete=false/error.

No lee contenidos de archivos enumerados ni convierte nombres inválidos a caracteres de reemplazo. complete=false impide usar esa respuesta como evidencia de eliminación. El escáner no conserva permisos: el anfitrión debe validar el ámbito autorizado y la generación antes de llamar, y decidir las exclusiones. No es todavía un indexador en árbol ni una cola persistente; no mantiene cursores entre llamadas. Las rutas largas, volúmenes en red, proveedores de nube, cambio de volumen y matices de cada filesystem requieren una matriz posterior de compatibilidad.

## Evidencias

- evidence/crossbuild.json: resultados de compilación por destino, tiempo, tamaño y SHA-256.
- evidence/unit-tests.txt: diez pruebas propias finales. go vet terminó con código 0 y sin salida.
- ../evidence/go-final.tap: trece casos comunes finales, incluidas las ocho pruebas r2, scanner adversario y relevo que muere tras recibir una escritura.
- Tests locales cubren Unicode/NFD, límites, recuperación después de error, rechazo de enlaces, lectura de secretos por handle, IDs/límites inválidos, SSE y clasificación de reintentos.

No se atribuyen los resultados de compilación cruzada a pruebas reales en macOS, Linux o Windows arm64. El despliegue de producto requiere esas pruebas y la adaptación del anfitrión.

# Incremento 08 — primer agente real

## Qué se construyó

Adaptador funcional para Codex CLI mediante MCP local por stdio, sobre el Motor
oficial en main `c9d06bf8cd24707e9efc5738dc787ed5f47e3359`.

- `src/codex-adapter.js`: protocolo y catálogo MCP con el SDK oficial 1.32.2,
  fijado junto a sus dependencias mediante package-lock.json.
- `src/codex-session.js`: anfitrión de una sesión, consentimiento explícito,
  identidad opaca y permiso de un solo intento del Motor existente.
- `src/codex-relay.js`: transporte transparente entre stdin/stdout del CLI y una
  IPC local del anfitrión; sin TCP, HTTP ni autorización administrativa.
- `scripts/codex-mind.mjs`: selecciona el archivo, pide consentimiento en el
  terminal del anfitrión y arranca una ejecución efímera del agente real.

El Motor, el lector nativo y su sistema de permisos no se modifican. No hay un
segundo registro de permisos, un servidor remoto ni una interfaz gráfica.

## Contrato aplicado

El usuario escoge una Base existente de desarrollo, un id de carpeta registrada,
un archivo relativo y un directorio vacío para el agente. El anfitrión muestra
la selección y el destinatario (Codex CLI y su modelo), pide `AUTORIZO` y solo
entonces llama a grantTextRead. La respuesta del modelo o un campo approved nunca
son consentimiento. La aprobación sucede antes de arrancar el CLI.

La identidad requester y el objeto permiso permanecen dentro del mismo Motor y
proceso anfitrión. El adaptador recibe solo una función ligada a ellos. El agente
ve `mind_read_text({})`, sin parámetros que cambien archivo, identidad o permiso.
Las claves adicionales se rechazan. No se publican administración, carpetas,
catálogos, índices, continuidad, funciones ni acceso general al sistema.

El CLI arranca su relay como un servidor MCP stdio. El relay no interpreta
mensajes: los transporta a la conexión local del anfitrión. La ruta IPC es
aleatoria; en POSIX se crea en un directorio propio con modo 0700 y en Windows
se usa un named pipe local. El anfitrión acepta una sola conexión y cierra el
listener. Reiniciar el relay o conectar otro cliente no renueva el permiso.
Cerrar o expirar la sesión revoca un permiso no usado. No se guardan concesiones.

Se reutiliza exactamente el intento único del lector: falla también después de
un error, una retirada de carpeta o un segundo intento concurrente. No hay
reintento ni reconcesión automática. La lectura segura mantiene todos sus límites
de plataforma y de confianza previos.

## Reproducción

Requisitos: Node.js 24, Python 3.12+, Codex CLI instalado y autenticado por el
usuario. `npm ci --ignore-scripts` instala el SDK. La suite automática y el
funcionamiento del Motor por sí solo no requieren autenticación de Codex.

1. Preparar un archivo UTF-8 ficticio pequeño fuera del repositorio y un directorio
   vacío separado para el agente. Usar la Base ficticia de desarrollo.
2. Registrar la carpeta con la CLI administrativa existente:
   `node src/cli.js --base <base absoluta> folder-add <carpeta absoluta>`.
3. Ejecutar el anfitrión:

```text
node scripts/codex-mind.mjs --base <base absoluta> --folder-id <id devuelto> --file prueba.txt --workdir <directorio vacío absoluto>
```

4. Comprobar el archivo y destinatario mostrados; escribir AUTORIZO para permitir
   un intento. Cualquier otra respuesta cancela antes de conceder el permiso.
5. Observar las dos llamadas del agente y los eventos de estado MIND_MCP en stderr.
   El lanzador exige OK y READ_NOT_AUTHORIZED para considerar verificado el piloto.
   Un exit code cero del CLI sin lecturas reales no basta.

En Windows se detecta la entrada JS de la instalación npm estándar de Codex y
se invoca con node, sin shell ni ejecución de npm.ps1/codex.ps1. Otra instalación
puede seleccionarse con `--codex <ejecutable o entrada JS>`. No se modifican
config.toml, credenciales ni configuraciones guardadas; se reutiliza la sesión
autenticada del usuario. stdout contiene los eventos JSONL del CLI y puede
capturarse como evidencia; esos eventos incluyen el texto autorizado. Los logs
propios MIND_MCP solo contienen estados/códigos, nunca el contenido.

## Compatibilidad comprobada con Codex CLI

Se probó Codex CLI 0.156.1 en Windows. En esta versión el runtime MCP necesita
plugins habilitado incluso para un servidor local, y Mind se configura como
namespace de llamadas directas con:

```toml
features.code_mode.enabled = true
features.code_mode.direct_only_tool_namespaces = ["mcp__mind"]
```

La opción code_mode es experimental en ese CLI y emite un aviso; no se oculta ni
se cambia configuración global para silenciarlo. El namespace Mind se usa solo
con llamadas directas: el prompt no pide ejecutores, ALL_TOOLS ni descubrimiento.
El SDK negocia el protocolo MCP. Los flags de ejecución ignoran configuración de
usuario para el piloto, desactivan shell, apps, navegador, computer use, memoria,
otros agentes, generación/visualización de imágenes y búsqueda web. Se usa sandbox
read-only, no una ampliación de permisos del sistema.

Estas opciones no acreditan aislamiento del SO ni autenticación de un cliente
remoto. El proceso, intérprete, código, usuario local y canal de lanzamiento son
de confianza. La IPC conecta componentes del mismo anfitrión; no protege de un
proceso hostil con los permisos del usuario. La prueba de agente real se limita
a Windows y a esa versión del CLI, no a todos los clientes o versiones posibles.
El piloto usa un texto pequeño; no prueba los límites de contexto del modelo con
archivos grandes. Se conserva el límite de lectura del Motor.

## Evidencia real

[evidence/incremento-08-codex.json](evidence/incremento-08-codex.json) contiene
eventos de la ejecución real del CLI, ambas llamadas MCP y la respuesta final del
agente, sin rutas personales, credenciales ni contenido de la Base. El texto es
ficticio y el marcador no se incluyó en el prompt. Se usó la Base de desarrollo;
el archivo y el workspace vacío del agente estaban fuera del repositorio.
Después de comprobar la evidencia se retiró la autorización ficticia; la Base de
desarrollo conservó únicamente su registro técnico previo.

La instrucción expresa de Aldo autorizó este piloto ficticio. El asistente
anfitrión introdujo AUTORIZO al ejecutarla; no se afirma que Aldo lo tecleó
manualmente. La identidad del solicitante y el permiso no se entregaron al agente.

Los intentos preliminares que terminaron sin llamadas MCP no se contaron como
éxito. Se añadió una prueba específica para impedir ese falso positivo. La
evidencia conservada corresponde a dos llamadas directas del agente real, no a
un cliente de prueba ni a una transcripción simulada.

## Pruebas

Windows local, npm.cmd test: 97 pruebas JavaScript (96 aprobadas y una omisión
FIFO POSIX), 10 nativas de lectura aprobadas y 12 nativas de indexación (11
aprobadas y una omisión inode POSIX). Cero fallos. Nueve pruebas nuevas cubren
negociación MCP por stdio, consentimiento estricto previo, catálogo de una
herramienta, bloqueo de cambios de destino/identidad y administración, un solo
intento concurrente, retirada, cierre/reconexión y rechazo de éxito sin llamadas.

CI instala el lockfile sin scripts y ejecuta la suite completa en Windows, macOS
y Linux. No ejecuta el agente de pago ni requiere credenciales del usuario. El
estado de esos checks se registra en la PR; no se infiere del resultado local.

## Qué falta para búsqueda con lectura

El archivo se elige manualmente desde el anfitrión. Falta conectar una consulta
autorizada al índice y producir candidatos dentro del ámbito permitido. Elegir
un candidato deberá generar una nueva autorización explícita para leer ese
archivo mediante el mecanismo existente. Encontrar un archivo o conocer su ruta
no concede permiso de lectura, y el agente no recibirá el índice completo ni la
API administrativa. No se implementa búsqueda con este incremento.

## Referencias de configuración verificadas

- [OpenAI: MCP local por stdio](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
- [OpenAI: ejecución no interactiva y JSONL](https://learn.chatgpt.com/docs/non-interactive-mode).
- [OpenAI: configuración de code mode y herramientas](https://learn.chatgpt.com/docs/config-file/config-reference).

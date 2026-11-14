# Motor Central («Un Solo Latido»)

Todos los chats abiertos comparten un único proceso de Mind por instalación. Antes,
cada chat cargaba su propio Mind completo; ahora cada chat mantiene solo un puente
fino y el trabajo lo hace un Motor Central que se enciende al necesitarlo y se apaga
solo.

## Piezas

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Motor Central | `src/motor-central.js` | Proceso único. HTTP en `127.0.0.1` con `/mcp`, `/rpc` y `/health`. Una sesión, un observador y unos índices para todos los chats. |
| Conector | `src/connector.js` | «El primero enciende»: encuentra el Motor vivo o lo lanza, y comprueba su identidad antes de hablarle. |
| Puente | `src/mcp-bridge.js` | Lo que inicia cada cliente (`mind mcp`). Traduce stdio ↔ HTTP/SSE. No abre Base ni índices. |
| Núcleo MCP | `src/mcp-core.js` | Protocolo MCP sin transporte, compartido por el Motor Central y por `mind mcp --direct`. |
| Cola | `src/smart-queue.js` | Lecturas en paralelo, escrituras ordenadas por carpeta, trabajo de fondo que cede. |
| Registro | `src/motor-log.js` | `motor-central.log` en la Base (una rotación). El Motor no tiene terminal. |
| Lanzador | `src/independent-launch.js` | Enciende el Motor y el relevista de una actualización sin que dependa del cliente que lo pide. |

## Independencia del cliente

El Motor sirve a todos los chats, así que no puede morir cuando se cierra el cliente
que lo encendió. Un solo contrato, un mecanismo por sistema:

- **Windows.** Los clientes de agentes ponen sus procesos en un Job Object que mata a
  todos sus descendientes al cerrarse; un proceso desacoplado lo hereda y la salida
  del job no está permitida. El Motor se crea mediante el servicio del sistema
  (WMI, `Win32_Process.Create`): nace fuera de todo job, en la misma sesión y con el
  mismo usuario, sin ventana. Cuesta unos 0,5 s, solo al encender en frío.
- **macOS y Linux.** No hay Job Objects: basta un proceso desacoplado en sesión nueva.

Si el mecanismo de Windows falla, se lanza desacoplado como antes y Mind funciona
igual. `estado` (`motor_central`) y `mind despertar` publican `independencia`
(`plena`, `heredada` o `desconocida`), `lanzamiento` y `cierre_anterior`.
`MIND_LANZAMIENTO_DIRECTO=1` fuerza el lanzamiento desacoplado.

**Cierre abrupto.** Un `conector.json` que sobrevive a su Motor significa que este no
se apagó en orden. El Motor siguiente lo registra («El Motor anterior terminó sin
cierre ordenado») y lo publica en `cierre_anterior`.

## Conexiones de los chats

Cada chat tiene un identificador de conexión estable mientras su cliente siga abierto.
Lo genera el puente al arrancar y lo envía en `X-Mind-Workspace` (`conexion`); un
puente relevo hereda el de su padre (`MIND_CONEXION`). Un cliente por HTTP directo no
tiene puente: su conexión es la sesión MCP.

- **Presencia.** Cada puente deja `Sistema/Estado/conexiones/conexion-<id>.json` (en
  desarrollo, en el temporal) y lo retira al cerrarse. Se ve aunque el Motor esté
  apagado; el de un puente muerto se descarta por su PID.
- **Registro del Motor.** Cliente y versión que declara el chat, transporte (`puente`
  o `http`), carpeta, peticiones en curso, formularios esperando al usuario y última
  petición real (`ping` no cuenta).
- `estado` añade `conexiones` (con `actividad`: `trabajando`, `esperando-al-usuario`,
  `activa`, `inactiva` o `sin-sesion`) y `quietud`.

**Regla de quietud.** Para sustituir el programa: nadie trabajando (tampoco por `/rpc`),
ningún formulario abierto y ninguna petición real en los últimos 30 s
(`MIND_QUIETUD_MS` la cambia). `/rpc` admite `{accion:'quietud'}` y
`{accion:'apagar', soloSiQuieto:true}`; si no hay quietud responde `busy` con los chats
que la impiden. La actualización solo apaga el Motor con quietud; si no, sus sesiones
dejan la entrega preparada y se reintenta.

**Actualizaciones.** El Motor solo descubre: 20 s después de encender, y luego cada
6 h mientras siga vivo, consulta el canal firmado (unos KB). No descarga ni instala;
no cuenta como actividad ni lo mantiene despierto.

`mind mcp --direct` conserva la sesión completa en el propio proceso, sin Motor Central.

## Órdenes

- `mind mcp`: puente del chat. Es lo que configuran los cuatro clientes.
- `mind despertar`: enciende o reutiliza el Motor y muestra su estado (versión, PID,
  sesiones, cola, trabajo de fondo). `--headers` imprime la cabecera de autorización.
- `mind apagar`: lo detiene de forma ordenada.
- `mind inicio`, `mind estado`, `mind herramienta`: usan el Motor Central por `/rpc`.
- `estado` añade `motor_central` (`version`, `pid`, `estado`, `sesiones`).

## Archivos en la Base

- `conector.json`: puerto, PID y versión del Motor vivo. Se borra al apagar.
- `conector-secreto.json`: secreto local (modo `0600`). Si falta, está vacío o dañado,
  el Motor lo regenera al arrancar.
- `conector.lock`: garantiza un solo Motor por Base.
- `motor-central.log` y `motor-central.log.1`: registro.

Ninguno entra en los respaldos. El motivo de un arranque fallido viaja en un archivo
de nombre aleatorio del directorio temporal, que crea quien lanza el Motor.

## Contrato entre el puente y el Motor

Un puente de una versión puede encontrarse con un Motor de otra (ver «Actualización
con chats abiertos»). Este contrato solo se amplía de forma compatible:

1. **Descubrimiento.** El cliente lee `conector.json` y pide
   `GET /health?nonce=<hex aleatorio>`. El Motor responde con
   `proof = HMAC-SHA256(secreto, "mind-health-v1\n" + nonce + "\n" + baseId + "\n" + puerto)`.
   Sin esa prueba el cliente no envía el secreto: un `conector.json` obsoleto puede
   apuntar a un puerto que ahora ocupa otro programa.
2. **Autorización.** `Authorization: Bearer <secreto>` en `/mcp` y `/rpc`. Se rechaza
   toda petición con `Origin` y toda cabecera `Host` distinta de `127.0.0.1:<puerto>`.
3. **Ámbito de trabajo.** Solo en `initialize`: `X-Mind-Workspace` =
   base64url(UTF-8 de `{"cwd": string|null, "paths": string[]}`). Las cabeceras HTTP
   solo admiten Latin-1 y una ruta puede tener cualquier carácter. Sin cabecera no
   hay ámbito: el Motor nunca presta su propia carpeta de trabajo.
4. **Sesión.** `Mcp-Session-Id` por chat. `GET /mcp` abre el flujo SSE por el que el
   Motor pide confirmaciones al usuario. `DELETE /mcp` cierra la sesión.
5. **Rechazos sin procesar.** `401`, `404` de sesión y `503` (apagándose) significan
   que la petición no se ejecutó: el cliente puede repetirla.

## Garantías del puente

- Cada petición con `id` recibe exactamente una respuesta JSON-RPC.
- Una escritura no se repite a ciegas. Solo se reintenta lo que no llegó al Motor, lo
  que el Motor rechazó sin procesar, o lo que es de solo lectura. Si la conexión se
  pierde a mitad de una escritura, el agente recibe `MOTOR_CONNECTION_LOST` («no se
  sabe si terminó; compruébalo antes de repetir»).
- Nada se reenvía antes de que el Motor haya recibido `initialize` y
  `notifications/initialized`, en ese orden.
- `ping` y el flujo SSE nunca despiertan un Motor apagado.
- Un fallo de arranque solo es definitivo si es determinista (Base más nueva, marca
  dañada, componente ausente). Cualquier otro se reintenta en la siguiente llamada.

## Ciclo de vida

- **Activo.** Atiende llamadas.
- **Reposo ligero** (3 min sin llamadas). Pausa los sondeos periódicos, vacía la caché
  de índices y descarga el subproceso semántico. Conserva `fs.watch`.
- **Autoapagado** (10 min sin llamadas). Cierra todo y termina. La siguiente llamada
  real de cualquier chat lo vuelve a encender.
- **Trabajo de fondo.** Un recorrido inicial o una preparación semántica en curso
  aplazan el reposo y el apagado, con un tope de 30 min para que un trabajo atascado
  no mantenga el Motor despierto.
- **Apagado ordenado.** Deja de anunciarse, concede 5 s a lo ya admitido, cierra las
  sesiones y solo entonces libera la Base. Lo que llega durante el apagado recibe
  `503` y se repite contra el Motor siguiente.
- **Cliente que se va.** Si corta la conexión, sus llamadas en curso se cancelan,
  incluido el formulario que estuvieran esperando.
- **Sesión abandonada.** Sin flujo abierto, sin peticiones y sin actividad durante
  15 min, se cierra. Un puente vivo que vuelva recibe `404` y abre otra.

## Cola

- **Lectura** (`buscar`, `leer`, `explorar`, `estado`…): inmediata y en paralelo.
- **Escritura** (`crear`, `modificar`, `mover`, `borrar`…): exclusiva por carpeta, en
  orden de llegada. Carpetas distintas avanzan a la vez.
- **Fondo** (indexación, vectores): cede mientras haya lecturas o escrituras.
- **Confirmaciones.** Mientras una herramienta espera al usuario (`borrar`,
  `vaciar_papelera`, `solicitar_acceso`), suelta la exclusión de su carpeta y la
  recupera al recibir la respuesta. Un formulario pendiente en un chat no detiene a
  los demás.

## Actualización con chats abiertos

Un chat inactivo no impide actualizar: su puente no abre la Base y el Motor inactivo
se apaga antes de la actualización. Después:

- El puente abierto sigue ejecutando el programa anterior. Al volver a conectar y
  encontrar un Motor de otra versión, inicia un puente del programa instalado (la
  misma orden con la que el cliente lo lanzó) y pasa a reenviarle los mensajes. El
  chat sigue funcionando sin reiniciar nada.
- En Windows, el ejecutable de Node del programa anterior sigue en uso y no puede
  borrarse. La actualización lo aparta a `Sistema/Actualizaciones/Retirados` y se
  borra cuando ya nadie lo usa (al iniciar otra actualización o al encender el Motor).

## Pruebas

- `test/motor-central.test.js`: seguridad, aislamiento por sesión, reposo, apagado,
  cola, cancelación, sesiones abandonadas, trabajo de fondo.
- `test/connector.test.js`: prueba de identidad, reintentos seguros, secreto.
- `test/mcp-bridge.test.js`: rutas de cualquier idioma, reintentos, recuperación.
- `test/smart-queue.test.js`: exclusión, suspensión, cancelación, multiclave.
- `test/update-open-bridge.test.js`: actualización real con un chat abierto.
- `test/independent-launch.test.js`: comillas de Windows, caída al modo anterior, datos
  fuera del guion de PowerShell, y en Windows un Job Object real que mata al puente y
  a un hijo desacoplado mientras el proceso lanzado por Mind sobrevive.

## Relevo asistido y verificación de la Base

actualizacion_aplicar obtiene consentimiento ligado a la entrega firmada. El
relevista usa una copia independiente de programa y runtimes, prepara con el Motor
vivo y espera /rpc quietud. Antes del apagado condicionado publica relevo.json con
fase aplicando; los clientes esperan esa barrera. Una carrera con trabajo nuevo
hace volver a espera-quietud.

La verificación abre un Motor con el Node y Python instalados, sobre la Base real,
sin publicar conector. Solo un encabezado aleatorio de verificación admite la
acción RPC verificar-actualizacion: lee identidad, formato, carpetas y continuidad.
El hijo se cierra antes del commit y vigila la identidad de su relevista. La
transacción conserva la copia previa hasta ese commit; al recuperar, comprueba
sesiones y no restaura mientras haya otro proceso vivo sobre la Base.

El acta queda en relevo.json y se entrega una vez por conexión, incluso si la
actualización falló. actualizacion_consultar expone fase y resultado. La recuperación
por corte reconoce también snapshotting, snapshotted y restoring-base; nunca trata
un propietario desconocido como muerto.

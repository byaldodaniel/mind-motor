# Respaldo cifrado de la Base — Hito B3

El respaldo contiene los datos de la Base: autorizaciones, índices, propiedades,
continuidad, definiciones y auditoría. Los originales permanecen en sus carpetas;
no se copian al respaldo. La configuración y la restauración son operaciones del
usuario. El agente solo puede crear un respaldo en el destino ya configurado.

## Órdenes del usuario

Desde la carpeta portable, con una carpeta de destino que ya exista:

```text
mind respaldo configurar <carpeta-de-respaldos>
mind respaldo crear
mind respaldo crear <otra-carpeta>
mind respaldo estado
mind respaldo verificar <archivo.mindbak>
mind respaldo verificar <archivo.mindbak> --codigo
mind respaldo verificar <archivo.mindbak> --archivo-recuperacion <archivo.json>
mind respaldo restaurar <archivo.mindbak> --codigo
mind respaldo restaurar <archivo.mindbak> --archivo-recuperacion <archivo.json>
mind respaldo restaurar <archivo.mindbak> --clave-local
```

En desarrollo, se usa `node bin/mind.js respaldo ... --base <ruta-absoluta>`.
No se necesita un servidor permanente. `crear`, `estado` y la verificación con la
clave local pueden ejecutarse sin terminal interactivo. Configurar, restaurar y
pedir material de recuperación requieren un terminal del usuario.

`configurar` comprueba el destino antes de pedir secretos. Después pregunta dónde
guardar el archivo de recuperación y solicita dos veces una frase de al menos 12
caracteres, mediante una entrada sin eco. Guarda primero el archivo protegido y
después la clave de la Base. Muestra una sola vez el código físico y pregunta si
se ha anotado. No acepta frases ni códigos mediante argumentos ni variables de
entorno. El usuario debe conservar el código o el archivo con su frase fuera de
la Base y separados de los respaldos. Perder ambos impide recuperar un respaldo
si tampoco se conserva la clave de la Base original.

`verificar` comprueba el cifrado autenticado y todos los archivos sin restaurar.
Sin opciones usa la clave de la Base local. Las otras modalidades solicitan el
código o la frase en el terminal. Se elige una sola modalidad por operación.

`restaurar` comprueba que no haya sesiones activas. Si la Base contiene datos,
restaura primero en una carpeta hermana nueva y pregunta si se debe usar esa
copia. Al aceptar, conserva la Base anterior en otra carpeta; nunca la borra.
Vuelve a comprobar sesiones antes del reemplazo. Si el usuario rechaza el cambio,
la Base actual queda intacta y la copia recuperada queda disponible aparte. Una
Base de formato posterior al Motor queda restaurada aparte, sin sustituir la
actual. La clave recuperada permite seguir respaldando con el mismo código y
archivo de recuperación.

## Herramienta del agente

`crear_respaldo` no recibe parámetros y solo utiliza el destino que el usuario
configuró. Registra la creación en la auditoría y limita los intentos a uno por
minuto por instancia de la herramienta. No expone el tamaño del respaldo. No
configura destinos, no entrega material de recuperación y no restaura datos.
Este límite por instancia no es un bloqueo global entre conexiones distintas.

## API administrativa

Las funciones están en `src/backup.js`. Todas reciben rutas absolutas:

- `prepareBackupSetup({passphrase})`: prepara en memoria el código, el archivo
  protegido y una función `commit(baseDirectory)` que guarda la clave una vez.
- `setupBackup({baseDirectory, passphrase})`: configura directamente la clave y
  devuelve el código y el contenido del archivo de recuperación al anfitrión.
- `checkBackupDestination({baseDirectory, destinationDirectory})` y
  `checkRecoveryLocation({directory, baseDirectory, destinationDirectory})`:
  validan ubicaciones físicas sin guardar configuración ni claves.
- `saveRecoveryFile({recoveryFile, directory, baseDirectory,
  destinationDirectory})`: publica el archivo con un nombre libre, sin reemplazo.
- `configureBackupDestination`, `readBackupConfig`, `describeBackupKey`:
  administran el destino y consultan metadatos públicos de la clave.
- `createBackup({baseDirectory, destinationDirectory, signal})` y
  `createConfiguredBackup({baseDirectory, signal})`: crean un archivo `.mindbak`.
- `listBackups(destinationDirectory)` e `inspectBackup(file)`: consultan nombres
  y metadatos; inspeccionar la cabecera no equivale a verificar el respaldo.
- `verifyBackup({file, ...material})`: autentica y comprueba el contenido completo.
- `restoreBackup({file, targetDirectory, restoreKey, ...material})`: restaura
  únicamente en una carpeta nueva o vacía fuera del Motor. `restoreKey` vale
  `true` por defecto. No reemplaza una Base que tenga datos.

`material` es exactamente una de estas alternativas: `{baseDirectory}`,
`{recoveryCode}` o `{recoveryFile, passphrase}`. `recoveryFile` admite una ruta
absoluta o su contenido JSON. Esta API pertenece al anfitrión administrativo;
no se entrega directamente al agente. La API de bajo nivel no consulta sesiones
para un destino nuevo; la orden del usuario realiza esa comprobación al cambiar
la Base instalada.

## Formato y garantías

Cada configuración tiene una clave maestra aleatoria de 256 bits en
`backup-key.json`. Esa clave no entra en la carga del respaldo. Cada respaldo
usa una clave de datos aleatoria independiente: comprime con zlib y cifra con
AES-256-GCM, con nonce de 96 bits y etiqueta de 128 bits. La cabecera se autentica
como datos asociados. Incluye identificadores y fechas en claro; el cifrado no
oculta el tamaño ni esos metadatos.

La clave de datos se envuelve con la clave maestra. Dos envolturas independientes
permiten recuperar la clave maestra: una derivada del código físico aleatorio de
160 bits y otra de la frase del archivo digital. Se usa scrypt con `N=131072`,
`r=8`, `p=1`, sal aleatoria de 32 bytes y separación de propósito en los datos
autenticados. El código usa base32 de Crockford y un grupo de comprobación para
errores de transcripción. La frase se normaliza a NFC y se recortan espacios de
los extremos. El código y la frase en claro no se guardan en los archivos.

El manifiesto cifrado contiene el SHA-256 y tamaño de cada archivo. La restauración
se escribe en una carpeta temporal hermana, verifica etiquetas y manifiesto, y
solo después publica el destino. Ante un error se elimina el temporal. Se
rechazan recorridos relativos inseguros, entradas duplicadas y límites de tamaño.
Los archivos se publican sin reemplazar nombres ocupados. Los destinos se
resuelven físicamente para rechazar solapamientos incluso mediante enlaces.

Se excluyen la clave local, las sesiones, las solicitudes transitorias de
consentimiento, los bloqueos y temporales reconocidos. Los enlaces de la Base se
omiten y se informan en el resumen. En POSIX los archivos nuevos de clave,
recuperación y respaldo usan modo `0600`; el acceso en Windows depende además de
los permisos del directorio y del sistema.

## Evidencia y límites pendientes

`node --test test/backup.test.js` verifica ambas recuperaciones sin la Base
original, nuevos respaldos desde una Base recuperada, scrypt de producción,
credenciales equivocadas, alteración y truncado, ausencia de publicación parcial,
destinos ocupados, conservación de la Base anterior, sesiones activas, prompt de
configuración, material no guardado en claro, rutas solapadas y enlaces, órdenes
y herramienta del agente. Los datos son ficticios y viven fuera del repositorio.

La validación local descrita es Linux; Windows, macOS, el terminal interactivo
real y los paquetes extraídos requieren sus propias ejecuciones verificables.
Las pruebas no sustituyen una revisión criptográfica independiente.

La Base y su espacio de montajes se consideran de confianza. No hay una
instantánea transaccional de todos los archivos: cada archivo se lee mediante
su descriptor, pero cambios entre registros durante la copia pueden representar
momentos distintos. Para un punto de recuperación estable, cerrar las sesiones
antes de crear el respaldo. Las comprobaciones de sesiones antes de sustituir
la Base no constituyen una exclusión mutua con procesos que se abran justo
después de la última comprobación. Tampoco se garantiza una recuperación frente
a cortes de energía o manipulación privilegiada de rutas durante la operación.

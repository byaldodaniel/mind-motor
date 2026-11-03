# Propiedades e identidad de los elementos (Hito B2)

Las propiedades se guardan en la Base. No se escriben en los originales.
Consultar requiere `encontrar`; asignar requiere `escribir`. Las exclusiones y la
generación de autorización de la carpeta se comprueban también al consultar.

## Reemplazos entre reconciliaciones

El nombre de un archivo no identifica al objeto: otro archivo puede ocupar la
misma ruta antes del siguiente recorrido, incluso con el mismo contenido,
tamaño y fecha de modificación. El índice conserva ahora la identidad obtenida
por el auxiliar seguro de metadatos:

- POSIX: dispositivo e inode (`posix:<dispositivo>:<inode>`).
- Windows: volumen y FileId (`nt:<volumen>:<FileId>`), mediante
  `FileIdBothDirectoryInfo` del directorio ya abierto.

No se abren contenidos para obtenerla. El formato persistido del índice pasa a
versión 3, con `identity` por entrada (`null` si no se pudo verificar). El Motor
sigue leyendo índices v1 y v2; una reconciliación genera el formato actual.
Cambiar la identidad cuenta como modificación aunque tamaño y fecha coincidan.

El archivo `folder-properties-<id>.json` usa la versión 2: cada entrada contiene
`path`, `identity` y `properties`. Solo se devuelven propiedades cuya identidad
coincide con una entrada verificada del índice vigente. No se permite asignar
propiedades si falta identidad (`ENTRY_IDENTITY_UNAVAILABLE`). La herramienta
`propiedades` reconcilia según el modo de la sesión antes de consultar.

Modificar texto con Mind publica un objeto nuevo mediante sustitución atómica.
El auxiliar devuelve las identidades anterior y nueva, y el Motor conserva solo
las propiedades ligadas al objeto anterior que realmente modificó. Mover y
restaurar conservan la identidad: las propiedades retiradas llevan ese vínculo
y solo se reponen si el destino sigue siendo el mismo objeto. Un reemplazo
externo durante el movimiento no recibe sus propiedades.

## Compatibilidad de las propiedades anteriores

Los registros v1 no guardaban identidad. No se puede demostrar a qué objeto
pertenecen, por lo que sus valores no se atribuyen automáticamente a los archivos
actuales. Consultarlos no cambia el archivo histórico. Si se asignan propiedades
a otra ruta, los valores anteriores se conservan en el nuevo formato con
`identity: null`, sin incluirse en búsquedas ni CSV. Asignar explícitamente a la
misma ruta establece propiedades para su objeto actual. Los elementos de papelera
antiguos sin identidad se restauran, pero no se les atribuyen automáticamente sus
propiedades históricas.

Los índices son datos derivados y pueden reconstruirse. Las propiedades
históricas se conservan como datos; no se deben borrar para migrar un índice.
Versiones anteriores del Motor no entienden los nuevos formatos: no deben
compartir una Base activa con esta versión.

## Marca global y protección de versiones anteriores

El formato global de Base pasa a versión 2. Antes de publicar un índice v3 o
propiedades v2, el Motor eleva `mind-base.json` a versión 2 bajo coordinación
global entre procesos. Conserva `baseId`, fecha y demás metadatos de la marca.
Si no puede elevarla, no publica el subformato nuevo. Si la marca se publicó y
la escritura posterior falla, permanece en versión 2: es un estado conservador,
sin restaurar formatos incompatibles ni rebajar la protección.

Abrir una Base v1 no cambia sus bytes por sí solo. La migración ocurre al
publicar uno de los subformatos nuevos. Consultar mediante la API del núcleo no
crea una marca en una Base sin ella; la primera publicación del nuevo formato
sí añade su marca global. Las Bases nuevas del producto nacen con formato 2.
El núcleo actual comprueba la compatibilidad de una marca existente al abrir.

Las entradas del producto anterior que usan `ensureBase` rechazan esta Base con
`BASE_TOO_NEW`; el actualizador rechaza un paquete cuyo Motor solo entiende
formato 1 antes de sustituir la instalación. Los manifiestos generados declaran
la versión que admite realmente el Motor, desde la misma constante de formato.

El núcleo histórico que invocaba directamente `openMotor` no comprobaba esta
marca, y un proceso antiguo ya abierto tampoco recibe una protección retroactiva.
No se debe compartir la Base con procesos o APIs de versiones anteriores;
deben cerrarse antes de migrar. La migración de metadatos y las pruebas sintéticas
del actualizador no sustituyen la validación de paquetes portables reales.
B2 sigue pendiente de CI en Windows y macOS.

## Límites

La comprobación se refiere al último índice verificado; no es una instantánea
frente a cambios externos concurrentes. Los identificadores del sistema de
archivos pueden reutilizarse después de eliminar un objeto. Dispositivo/inode y
volumen/FileId no prueban procedencia histórica absoluta frente a esa reutilización.
Las Bases, intérpretes, código y montajes siguen siendo de confianza.

La suite `test/properties-indexes.test.js` cubre reemplazos entre recorridos,
conservación al modificar por Mind, movimiento entre carpetas, rechazo al reponer
propiedades sobre un reemplazo, compatibilidad conservadora, escrituras desde
dos procesos, regeneración CSV desde otro proceso, ediciones externas y
exclusiones. Las pruebas de papelera con propiedades están en
`test/organize-agent.test.js`. La ejecución en Linux no sustituye la matriz real
de Windows y macOS.

# Modificar archivos existentes — Función 03

Sustitución segura del contenido de **un archivo de texto UTF-8 existente**
dentro de una carpeta autorizada. El agente aporta el nuevo contenido completo y
la versión sobre la que trabajó; Mind publica el cambio solo si el archivo sigue
siendo exactamente esa versión. No hay movimiento, eliminación ni documentos
complejos.

Módulo independiente: `src/text-modifier.js` (JS) y `src/native_modifier.py`
(auxiliar nativo, biblioteca estándar, reutiliza `native_reader.py`). `openMotor`
lo expone; véase [INTERFACES.md](INTERFACES.md) para la integración y el índice.

## Uso del anfitrión

```js
import { createTextModifier, textVersion } from './src/text-modifier.js';

// loadAuthorizedFolder es el resolutor privado del registro de carpetas existente.
const modifier = createTextModifier({ loadAuthorizedFolder, pythonExecutable });
// Tras la autorización explícita del usuario, solo el anfitrión concede.
const authorization = await modifier.grantTextModify({ requester, folderId, relativePath: 'notas/a.txt' });

// El agente leyó el archivo con readTextFile y calcula la versión de lo que vio.
const expectedVersion = textVersion(leido.content); // "sha256:<hex>"
const result = await modifier.modifyTextFile({ requester, authorization, expectedVersion, content: nuevoTexto });
// { folderId, relativePath, size, previousVersion, version, indexEntry }
```

| Operación | Entrada | Resultado |
|---|---|---|
| `grantTextModify` | `{ requester: object, folderId, relativePath }` | Permiso opaco de un intento |
| `revokeTextModify` | Permiso | `boolean`: retirado antes del intento |
| `modifyTextFile` | `{ requester, authorization, expectedVersion, content }` | Resultado con nueva versión e `indexEntry` |
| `textVersion(content)` | Texto | `"sha256:<64 hex>"` de sus bytes UTF-8 |

`textVersion` coincide con el archivo porque `readTextFile` devuelve UTF-8
estricto con el BOM preservado: decodificar y volver a codificar da los mismos
bytes. `result.version` sirve como `expectedVersion` de la siguiente modificación.

## Autorización

Mismo modelo que lectura y creación, sobre el registro de carpetas existente:
permiso opaco en un `WeakMap` propio de la modificación, ligado al objeto
`requester`, a la carpeta (id + generación) y a la ruta exacta. Un solo intento,
consumido antes de validar o abrir. Se revalida el registro con el archivo ya
abierto y verificado, justo antes de escribir. Permisos de lectura o de otra
instancia no autorizan modificar, ni al revés.

## Algoritmo nativo

1. Valida el nuevo contenido (UTF-8 estricto, sin NUL, ≤ 1 MiB) y la versión.
2. Adquiere raíz, carpetas y archivo por componentes sin seguir enlaces, con las
   clases del lector seguro. El archivo debe ser regular, con un solo enlace,
   del mismo volumen y no un punto de reanálisis.
   - Windows: se solicita explícitamente FILE_WRITE_DATA además de los derechos
     existentes, compartiendo solo lectura y borrado. Otra apertura de Mind para
     modificar el mismo archivo falla con `FILE_IN_USE` mientras se mantiene
     este handle; también se rechazan escritores incompatibles ya abiertos.
   - macOS/Linux: inmediatamente después de abrir se adquiere
     `fcntl.flock(LOCK_EX | LOCK_NB)`. Si está ocupado, `FILE_IN_USE`. Tras
     adquirirlo se comprueba que la ruta sigue designando el inode abierto:
     un descriptor anterior a otro reemplazo da `VERSION_CONFLICT`, aunque el
     bloqueo del inode antiguo ya se haya liberado.
3. Lee el contenido actual por ese handle (≤ 1 MiB, UTF-8 estricto) y compara su
   SHA-256 con la versión esperada. Si difiere: `VERSION_CONFLICT`.
4. Comprueba que los metadatos de seguridad se pueden conservar; si no, rechaza.
5. Avisa `READY`; Node revalida la autorización y responde `W`.
6. Escribe el contenido completo en un temporal exclusivo
   `.mind-modify-<uuid>.tmp` del mismo directorio, con los metadatos trasladados,
   y lo sincroniza con disco.
7. Comprueba de nuevo que el nombre sigue designando el archivo verificado:
   - Windows: mismo volumen e índice de archivo, sin reanálisis.
   - POSIX: mismo inode, tamaño, mtime y ctime, en el nombre y en el handle.
8. Publica con un rename atómico respecto al padre adquirido:
   - Windows: `FileRenameInformationEx` con `REPLACE_IF_EXISTS | POSIX_SEMANTICS`
     (sin ignorar solo lectura). Si el sistema de archivos no lo admite, se
     rechaza con `SAFE_OPEN_UNAVAILABLE`.
   - POSIX: `renameat` y sincronización del directorio.
9. Confirma que el archivo sustituido era el verificado (sin enlaces o con
   borrado pendiente). Si no, `MODIFY_UNCONFIRMED`.
10. Ante cualquier fallo anterior a publicar, descarta el temporal; el original
    queda intacto. Nunca se trunca ni se escribe sobre el original.

El bloqueo del original permanece durante la versión, preparación y publicación;
se libera al cerrar su descriptor, también ante excepciones o cancelación. No se
crean archivos de bloqueo, servicios ni dependencias externas.

## Metadatos conservados o motivo de rechazo

| Sistema | Se conserva | Se rechaza (`METADATA_NOT_PRESERVABLE` o `ACCESS_DENIED`) |
|---|---|---|
| Windows | Fecha de creación; atributos oculto, archivo, no indexado | Solo lectura; flujos de datos alternativos; DACL con entradas explícitas o protegida; otros atributos (cifrado, comprimido, disperso…) |
| POSIX | Modo de permisos y grupo | Sin escritura para el dueño; setuid/setgid/sticky; otro propietario; atributos extendidos o ACL en Linux (salvo la etiqueta SELinux) |

## Preparación del índice

`indexEntry` tiene la forma exacta de una entrada de `index-scan.js`; la
`openMotor` la usa para sustituir la entrada de esa ruta en el índice vigente
(véase [INTERFACES.md](INTERFACES.md)).

## Errores

`INVALID_REQUESTER`, `INVALID_MODIFY_PATH`, `INVALID_VERSION`, `INVALID_TEXT`,
`TEXT_TOO_LARGE`, `FOLDER_NOT_AUTHORIZED`, `MODIFY_NOT_AUTHORIZED`,
`FILE_NOT_FOUND`, `UNSAFE_PATH`, `ACCESS_DENIED`, `FILE_IN_USE`, `FILE_TOO_LARGE`,
`TEXT_UNREADABLE`, `VERSION_CONFLICT`, `METADATA_NOT_PRESERVABLE`, `NO_SPACE`,
`MODIFY_FAILED`, `MODIFY_UNCONFIRMED`, `SAFE_OPEN_UNAVAILABLE`.

## Límites

- En macOS/Linux `flock` es consultivo. Excluye a los modificadores cooperativos
  de Mind; un programa externo que no lo respete puede escribir o reemplazar el
  archivo. Se conservan las comprobaciones de identidad, tamaño, mtime y ctime,
  pero la comprobación final y `renameat` no forman un compare-and-swap atómico
  frente a esos programas. No se declara seguridad absoluta ante sus escrituras.
- Windows impide escribir el contenido mientras dura la operación, pero permite
  renombrar o borrar el archivo: queda la misma ventana mínima entre la
  comprobación del nombre y el rename.
- La identidad del archivo cambia con cada modificación: inode o índice de
  archivo nuevos, como en cualquier guardado atómico.
- macOS: Python estándar no permite consultar atributos extendidos ni ACL; no se
  verifican. Tampoco se conserva la fecha de creación.
- Si el proceso muere a mitad puede quedar un temporal oculto; el original sigue
  intacto. Si muere justo después de publicar, el cambio existe aunque se informe
  un fallo.
- Solo volúmenes locales fijos con letra en Windows; POSIX necesita `renameat`
  y un sistema de archivos que admita `flock`. No hay fallback sin bloqueo.
- Modelo de confianza igual que la lectura: anfitrión, intérprete y código de
  confianza; no aísla código hostil del mismo usuario.
- El contenido nunca se guarda en la Base.

## Pruebas

`test/text-modifier.test.js` cubre el flujo de punta a punta y los permisos.
`test/native_modifier_test.py` cubre las carreras deterministas y la
publicación. Lo ejecuta `test/native-modifier.test.js`, de modo que CI lo
incluye sin modificar `scripts/test.mjs`.

### Regresión de concurrencia entre procesos

La corrección parte de main `29f5cce5536d45a4798c3b92508d7a013139c209`, en un
clon independiente. La regresión determinista falló en ese código en Windows:
el segundo proceso publicó mientras el primero estaba detenido antes de leer,
tras verificar la versión y con el temporal preparado (tres subcasos).

`test/fixtures/modifier_process.py` ejecuta el mismo auxiliar nativo en procesos
independientes. Las tuberías confirman cada barrera antes de lanzar el competidor
y solo lo liberan tras observar su resultado; no se usan sleeps. Las barreras
están únicamente en la prueba, mediante el backend de prueba ya existente, y
no pueden activarse desde la API o el protocolo productivo.

Se comprueba que únicamente uno publica y el otro obtiene FILE_IN_USE antes de
leer, después de verificar SHA-256 y con el temporal preparado; versiones viejas
fallan y las actualizadas permiten modificaciones secuenciales. En POSIX se
detiene otro proceso justo después de abrir el descriptor y antes del flock,
se publica un reemplazo y después se le permite adquirir el bloqueo antiguo:
debe devolver VERSION_CONFLICT. También se comprueban limpieza y liberación
tras error, cancelación, EOF y terminación antes de escribir.

La prueba JS adicional mantiene un proceso nativo en la barrera de publicación
y modifica desde otra invocación del Motor: FILE_IN_USE consume su permiso de
un intento, y una identidad diferente no puede utilizarlo. La suite completa
conserva las regresiones de lectura, creación, indexación y actualización del
índice. No se modifica su mecanismo de concurrencia.

Verificación local Windows, Node 24.18.0 y Python 3.12: `npm.cmd test`,
153 casos JS (152 aprobados, 1 omitido FIFO POSIX), incluida la ejecución del
auxiliar modificador con 16 casos nativos (15 aprobados, 1 caso de inode solo
POSIX). También pasan lectura nativa 10/10, indexación 11/12 (1 omisión POSIX) y
creación 12/12. Cero fallos. Los checks de la PR verifican además macOS y Linux,
incluido el caso del descriptor obsoleto, que en Windows no puede abrirse con
esa intercalación porque la exclusión se adquiere durante la propia apertura.

Referencias:
[Python flock](https://docs.python.org/3.12/library/fcntl.html#fcntl.flock) y
[Windows: derechos y compartición](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

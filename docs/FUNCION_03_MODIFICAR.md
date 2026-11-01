# Modificar archivos existentes — Función 03

Sustitución segura del contenido de **un archivo de texto UTF-8 existente**
dentro de una carpeta autorizada. El agente aporta el nuevo contenido completo y
la versión sobre la que trabajó; Mind publica el cambio solo si el archivo sigue
siendo exactamente esa versión. No hay movimiento, eliminación ni documentos
complejos.

Módulo independiente: `src/text-modifier.js` (JS) y `src/native_modifier.py`
(auxiliar nativo, biblioteca estándar, reutiliza `native_reader.py`). Aún no
está conectado a `openMotor`.

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
   - Windows: el archivo se abre compartiendo solo lectura y borrado. Mientras
     Mind lo mantiene abierto nadie puede escribirlo; si otro programa ya lo
     tiene abierto para escribir, se rechaza con `FILE_IN_USE`.
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

## Metadatos conservados o motivo de rechazo

| Sistema | Se conserva | Se rechaza (`METADATA_NOT_PRESERVABLE` o `ACCESS_DENIED`) |
|---|---|---|
| Windows | Fecha de creación; atributos oculto, archivo, no indexado | Solo lectura; flujos de datos alternativos; DACL con entradas explícitas o protegida; otros atributos (cifrado, comprimido, disperso…) |
| POSIX | Modo de permisos y grupo | Sin escritura para el dueño; setuid/setgid/sticky; otro propietario; atributos extendidos o ACL en Linux (salvo la etiqueta SELinux) |

## Preparación del índice

`indexEntry` tiene la forma exacta de una entrada de `index-scan.js`; la
integración podrá reemplazar la entrada de esa ruta bajo la misma generación de
autorización, sin recorrer de nuevo. Esta PR no escribe en el índice.

## Errores

`INVALID_REQUESTER`, `INVALID_MODIFY_PATH`, `INVALID_VERSION`, `INVALID_TEXT`,
`TEXT_TOO_LARGE`, `FOLDER_NOT_AUTHORIZED`, `MODIFY_NOT_AUTHORIZED`,
`FILE_NOT_FOUND`, `UNSAFE_PATH`, `ACCESS_DENIED`, `FILE_IN_USE`, `FILE_TOO_LARGE`,
`TEXT_UNREADABLE`, `VERSION_CONFLICT`, `METADATA_NOT_PRESERVABLE`, `NO_SPACE`,
`MODIFY_FAILED`, `MODIFY_UNCONFIRMED`, `SAFE_OPEN_UNAVAILABLE`.

## Límites

- POSIX no tiene bloqueos obligatorios. Entre la última comprobación (paso 7) y
  `renameat` queda una ventana de microsegundos en la que un cambio ajeno puede
  perderse. Una escritura ajena antes de esa comprobación se detecta.
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
- Solo volúmenes locales fijos con letra en Windows; POSIX necesita `renameat`.
- Modelo de confianza igual que la lectura: anfitrión, intérprete y código de
  confianza; no aísla código hostil del mismo usuario.
- El contenido nunca se guarda en la Base.

## Pruebas

`test/text-modifier.test.js` cubre el flujo de punta a punta y los permisos.
`test/native_modifier_test.py` cubre las carreras deterministas y la
publicación. Lo ejecuta `test/native-modifier.test.js`, de modo que CI lo
incluye sin modificar `scripts/test.mjs`.

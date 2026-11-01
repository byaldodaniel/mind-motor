# Crear información — Función 03, primer incremento

Creación segura de **un archivo de texto UTF-8 nuevo** dentro de una carpeta
autorizada. El agente decide el contenido; Mind ejecuta la operación con
precisión y solo con autorización explícita del anfitrión. No hay edición,
movimiento ni eliminación.

Módulo independiente: `src/text-creator.js` (JS) y `src/native_writer.py`
(auxiliar nativo, biblioteca estándar). `openMotor` lo expone; véase
[INTERFACES.md](INTERFACES.md) para la integración y la coherencia del índice.

## Uso del anfitrión

```js
import { createTextCreator } from './src/text-creator.js';

// loadAuthorizedFolder es el resolutor privado del registro de carpetas existente.
const creator = createTextCreator({ loadAuthorizedFolder, pythonExecutable });
const requester = Object.freeze({ name: 'Agente de prueba' });
// Tras la autorización explícita del usuario, solo el anfitrión concede.
const authorization = await creator.grantTextCreate({
  requester, folderId: carpeta.id, relativePath: 'notas/nueva.txt',
});
// Al agente se le entrega solo esta función ligada a su identidad.
const createForAgent = (permission, content) => creator.createTextFile({ requester, authorization: permission, content });
const result = await createForAgent(authorization, 'Texto ficticio\n');
// result: { folderId, relativePath, size, indexEntry }
```

| Operación | Entrada | Resultado |
|---|---|---|
| `grantTextCreate` | `{ requester: object, folderId, relativePath }` | Permiso opaco de un intento |
| `revokeTextCreate` | Permiso | `boolean`: retirado antes del intento |
| `createTextFile` | `{ requester, authorization, content: string }` | `{ folderId, relativePath, size, indexEntry }` |

## Autorización

- Mismo modelo que la lectura (Incremento 03), sin un sistema paralelo: el permiso
  es clave de un `WeakMap` privado y se liga al objeto `requester`, a la carpeta
  (id + generación del registro), a la ruta relativa exacta y a la operación.
- Los permisos de creación y de lectura viven en mapas distintos: uno nunca sirve
  para el otro. Copiar el objeto, conocer id/ruta, otro `requester` con el mismo
  nombre u otra instancia del creador no conceden nada.
- Un solo intento: se consume antes de validar el contenido o de cualquier E/S.
  Un fallo exige una nueva autorización.
- Se consulta el registro antes de abrir y otra vez con el directorio padre ya
  adquirido, justo antes de crear. Retirar o reautorizar la carpeta (nueva
  generación) invalida los permisos pendientes.

## Algoritmo nativo

1. Valida el contenido: UTF-8 estricto, sin NUL, máximo 1 MiB (también en JS).
2. Adquiere raíz y carpetas intermedias por componentes, sin seguir enlaces, con
   las mismas clases del lector seguro (`openat`/`O_NOFOLLOW` en POSIX;
   `NtCreateFile` con `RootDirectory` y `FILE_OPEN_REPARSE_POINT` en Windows).
   Rechaza enlaces, junctions, puntos de reanálisis y cambios de volumen.
   **No crea carpetas intermedias.**
3. Si el nombre final ya existe (archivo, carpeta o enlace) devuelve `FILE_EXISTS`.
4. Avisa `READY`; Node revalida la autorización y solo entonces envía `W`.
5. Crea un temporal exclusivo `.mind-create-<uuid>.tmp` en el directorio adquirido
   (`O_CREAT|O_EXCL|O_NOFOLLOW`; `FILE_CREATE` sin compartir en Windows), escribe
   todo el contenido y lo sincroniza con disco.
6. Publica sin reemplazar nunca:
   - Windows: `NtSetInformationFile(FileRenameInformation)` sobre el handle del
     temporal, `ReplaceIfExists = FALSE` y `RootDirectory` = padre adquirido.
   - POSIX: comprueba que el temporal sigue siendo el inode escrito, `linkat`
     al nombre final (falla con `EEXIST`), retira el temporal y sincroniza el
     directorio.
7. Si algo falla antes de publicar, el temporal se elimina por su handle
   (Windows) o tras verificar su inode (POSIX). El nombre final no llega a existir.
8. Devuelve tamaño y fechas leídas del handle del archivo creado.

## Preparación del índice

`indexEntry` tiene exactamente la forma de una entrada de `index-scan.js`
(`path`, `type: 'file'`, `size`, `state: 'indexed'`, `reason: null`,
`modifiedAt`, `changedAt`, `createdAt`). La integración podrá incorporarla al
índice de la carpeta, bajo la misma generación de autorización, sin recorrer de
nuevo. Esta PR no escribe en el índice.

## Errores

`INVALID_REQUESTER`, `INVALID_CREATE_PATH`, `FOLDER_NOT_AUTHORIZED`,
`CREATE_NOT_AUTHORIZED`, `INVALID_TEXT`, `TEXT_TOO_LARGE`, `FILE_EXISTS`,
`PARENT_NOT_FOUND`, `UNSAFE_PATH`, `ACCESS_DENIED`, `NO_SPACE`, `CREATE_FAILED`,
`CREATE_UNCONFIRMED`, `SAFE_OPEN_UNAVAILABLE`. Ningún mensaje incluye el contenido.

## Límites

- Mismo modelo de confianza que la lectura: anfitrión, intérprete, código y Base
  de confianza; no aísla código hostil del mismo proceso o usuario. Windows: solo
  volúmenes locales fijos con letra.
- Durante la operación existe brevemente un temporal oculto en la carpeta destino.
  Si el proceso muere a mitad (corte, timeout de 10 s), puede quedar ese temporal;
  nunca un archivo parcial con el nombre pedido. La fecha de modificación de la
  carpeta padre cambia, como en cualquier creación.
- POSIX requiere `linkat` en el sistema de archivos; si no está disponible (p. ej.
  FAT/exFAT) la operación falla sin recurrir a una creación más débil.
- POSIX: entre la comprobación de inode del temporal y `linkat` hay una ventana
  mínima ante otro proceso con permisos de escritura en esa misma carpeta.
- Si el proceso muere justo después de publicar, el archivo existe aunque Node
  informe un fallo (`CREATE_FAILED` por timeout o `CREATE_UNCONFIRMED`).
- Los permisos del SO siguen aplicándose; el archivo nuevo usa los permisos por
  defecto del sistema (umask / ACL heredada).
- El contenido nunca se guarda en la Base.

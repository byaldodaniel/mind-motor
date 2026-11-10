# Continuidad y traslado real C: → G: (DriveFS)

7 de noviembre de 2026. Windows x64. Datos ficticios, Base aislada en C: y carpetas únicas de ensayo en G:. No se utilizó la Base personal. Evidencia del código de desarrollo; no certifica publicación ni sincronización remota de Google Drive.

## Resultado

`scripts/probar-traslado-unidades.mjs` completó: guardar decisiones y registrar documento + PNG en C:, trasladar con el mismo ID a G:, cerrar, recuperar en otra sesión y corregir 23 muestras/viernes por 31/lunes, renombrar la carpeta en G: mediante Mind, recuperar desde una tercera sesión, actualizar el mismo Markdown y crear un resultado en la ruta vigente. Documento y PNG conservaron sus SHA-256; la memoria original en C: quedó intacta. Revisión final 5. La carpeta anterior al renombrado no se recreó.

Informe final: `traslado-c-a-g-renombrado.json`, en `C:\Users\Aldo Daniel\Desktop\Mind - Desarrollo\Borradores\2026-11-07 - Continuidad simple`.

## Incompatibilidad inicial y cambio acotado

El primer ensayo rechazó la copia con UNSAFE_PATH. DriveFS presenta FAT32, flags 0x106 y cero enlaces tanto en GetFileInformationByHandle como en FileStandardInfo para archivos regulares nuevos. Los handles tenían tipo de archivo 1, atributos normales 0x80 y no eran puntos de reanálisis. Los padres se adquirieron por componentes y handles relativos. Informes iniciales: `traslado-c-a-g.json`, `diagnostico-drivefs.json` y `diagnostico-drivefs-standard.json`.

El lector admite cero enlaces sólo si GetVolumeInformationByHandleW del mismo handle confirma FAT32, ausencia de FILE_SUPPORTS_HARD_LINKS y el mismo número de volumen. FileStandardInfo debe confirmar archivo regular, cero enlaces y ausencia de delete_pending. NTFS, proveedores desconocidos, consultas fallidas, múltiples enlaces y reparse points siguen rechazados. No se infiere soporte por letra o ruta. [Documentación de la API](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationbyhandlew).

DriveFS tampoco implementa FileStreamInfo (WinError87) ni FileRenameInformationEx con semántica POSIX (STATUS_INVALID_PARAMETER). Las consultas ADS/ACL sólo se omiten si los flags del volumen por handle confirman ausencia de FILE_NAMED_STREAMS y FILE_PERSISTENT_ACLS. Readonly y los demás atributos siguen protegidos.

## Reemplazo y exclusión

La alternativa de renombrado clásico sólo se habilita en ese proveedor confirmado, ante rechazos explícitos de la clase extendida. Se conserva el original abierto sin compartir WRITE ni DELETE. Un conjunto interno registra el handle exacto adquirido con esa exclusión; la prueba se elimina al cerrarlo. Una capacidad positiva posterior sobre el archivo no sustituye la prueba del handle realmente adquirido con DELETE excluido.

Se vuelve a comprobar la identidad del nombre original antes del renombrado clásico. Original y temporal permanecen abiertos hasta terminar. Después, el nombre final, abierto respecto al mismo padre retenido, debe ser regular, sin reparse, del mismo volumen, identificar exactamente al temporal y diferir del original. En DriveFS, delete_pending del original permanece en cero; el número de enlaces por sí solo no confirma el reemplazo. [Semánticas de renombrado nativo](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).

`scripts/probar-drivefs-exclusion.py` comprobó en G: que un handle DELETE preexistente de otro proceso impide comenzar la modificación; otro proceso tampoco puede renombrar el original en la barrera exacta posterior a la última comprobación y anterior al renombrado clásico. El reemplazo propio sí se completó con ambos handles retenidos. También se rechazó una verificación/copia segura mientras había un escritor abierto. Informe: `drivefs-exclusion-final.json`.

## Validación

- Lector nativo: 14/14 aprobadas.
- Escritor nativo: 15/15 aprobadas.
- Modificador nativo: 24 casos, 23 aprobados y uno omitido por diferencia POSIX/Windows.
- Organizador nativo: 9 casos, 8 aprobados y uno omitido por plataforma.
- Copia/verificación nativa: 10/10 aprobadas.
- Verificación JavaScript: 5/5 aprobadas en su ensayo específico.
- C:→G: con renombrado, tercera sesión, corrección del acuerdo y archivos íntegros: aprobado.

Las regresiones verifican NTFS/desconocido con cero enlaces, flags de enlaces físicos, volumen distinto, delete_pending, enlaces múltiples, reutilización de handles, falta de prueba de exclusión y cambios de nombre/identidad. Los intentos de renombrado convencionales del ensayo representan a procesos ajenos; el programa conserva las aperturas por descriptor.

Todas las carpetas únicas se limpiaron después de verificar su padre resuelto y prefijo. Los informes permanecen. El éxito local de DriveFS no acredita sincronización remota. macOS/Linux y otros proveedores requieren comprobaciones nativas propias. Este trabajo no publica versiones ni modifica la web.

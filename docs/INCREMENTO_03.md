# Incremento 03 — primera lectura segura

## Cierre del Incremento 02

Se volvieron a ejecutar las 27 pruebas en Windows con Node.js 24.18.0: todas
aprobadas. Se revisó el head `3d0116d1266055ee9db98274adf1cdac0956c8ab`, sin
revisiones pendientes, y los tres jobs aprobados de Actions, ejecución
`41177703133` (Windows, macOS y Linux). La PR #2 se fusionó verificando ese SHA;
`main` y el entorno local se sincronizaron en
`3a60bfae83c6a44083325856fadb62c432a38427`. El Incremento 03 parte de ese commit
en una rama independiente y se entrega mediante una PR sin fusionar.

## Qué se hizo

- Lectura de un único archivo de texto en una carpeta registrada, sin enumerar
  originales ni guardar su contenido en la Base.
- Permiso explícito, efímero y opaco, ligado a identidad por objeto, archivo y
  generación del registro; un solo intento. Registro de carpeta y permiso del
  solicitante son condiciones independientes.
- Apertura por referencias del SO, sin `realpath` seguido de `open` como sustituto.
- Errores diferenciados por autorización, permisos del SO, desaparición, enlaces,
  texto inválido, tamaño excesivo y fallo de lectura; sin resultados parciales.
- Instrucciones de uso selectivo: Mind es opcional, manteniendo las autorizaciones
  cuando el agente elija otras herramientas. No se desarrolló un gestor.

## Apertura y frontera de confianza

Node.js conserva la API y los permisos. Un auxiliar propio de Python 3.12+, sin
paquetes externos, realiza las llamadas nativas. Python se eligió para acceder a
las primitivas que Node.js no expone de forma equivalente en los tres sistemas,
sin compilación ni binarios descargados. El proceso del auxiliar es temporal y no
constituye un servicio, sandbox ni aislamiento de seguridad.

**macOS/Linux:** se parte de `/` y se abre cada componente de la raíz con
`os.open(dir_fd=..., O_DIRECTORY | O_NOFOLLOW)`, equivalente a `openat`. Los
componentes solicitados se abren respecto al descriptor ya adquirido. El archivo
se abre `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` y se valida con `fstat` antes de leer.
`O_NONBLOCK` evita quedarse esperando en un FIFO. No se siguen enlaces en ningún
componente, aunque se hayan insertado después de registrar o conceder permiso.

**Windows:** se abre la raíz del volumen local y cada componente con
`NtCreateFile`, `FILE_OPEN`, `RootDirectory` y un único nombre hijo. Se emplea
`FILE_OPEN_REPARSE_POINT` y se revisan tipo y atributos del mismo handle, rechazando
todos los reparse points antes de usarlo como directorio o leer. No se depende de
`OBJ_DONT_REPARSE` ni de volver a abrir una ruta completa. Los directorios solo
solicitan metadatos, sincronización y tránsito; el destino solicita lectura. El
handle final se convierte en descriptor para leer el mismo objeto.

En ambos casos se retienen referencias durante la apertura; renombrar una raíz o
subcarpeta ya adquirida no redirige las aperturas siguientes al sustituto. Tras
abrir el archivo se avisa al Motor sin leer contenido, se revalida el registro y
se confirma la lectura por ese descriptor. Si desaparece antes de abrir, se
informa; si se elimina después, puede seguir leyéndose el objeto ya abierto.
Solo se aceptan archivos regulares con un enlace duro y en el mismo volumen que
la raíz registrada. No se escribe ni trunca el original; el SO puede actualizar
atime. No se añade índice, escritura de originales, automatización o continuidad.

## Garantías limitadas y portabilidad

- El anfitrión conserva el método administrativo y concede el permiso tras la
  autorización del usuario. No hay autenticación remota ni aislamiento frente a
  código que ya controla el anfitrión, la Base, el intérprete o los permisos del
  usuario. El llamador no puede ser un proceso hostil con acceso a esas piezas.
- Windows admite volúmenes locales fijos con letra. UNC, dispositivos, rutas
  extendidas y almacenamiento no admitido se deniegan. La evidencia local cubre
  Windows/NTFS; CI cubre los sistemas de archivos de sus runners, no todos los
  controladores, versiones o servicios de almacenamiento posibles.
- Se rechazan cambios de volumen en descendientes, pero no se acredita la ausencia
  de montajes bind en el mismo dispositivo, cambios privilegiados del espacio de
  montajes o del espacio de nombres de dispositivos. Ese espacio se considera de
  confianza; no existe una garantía universal y portable frente a esos cambios.
- El registro conserva el significado de ubicación del Incremento 02. No congela
  identidades históricas de carpetas/archivos. Las referencias protegen el objeto
  adquirido durante la operación, aunque otro proceso lo mueva fuera de su antigua
  ubicación. No se promete pertenencia por nombre continuamente revalidada.
- La comprobación de enlaces duros es puntual; no prueba procedencia histórica ni
  impide que otros creen un enlace después. No se garantiza una instantánea o
  contenido inmutable frente a escrituras concurrentes sobre el mismo objeto.
- El Motor no modifica bytes ni mtime; atime puede cambiar por acción del SO.
- No hay degradación a una precomprobación de rutas cuando falta el auxiliar o una
  primitiva requerida: se informa y se deniega.

## Evidencia

`npm test` ejecuta las pruebas JavaScript y las pruebas nativas Python. Todos los
temporales son ficticios y hermanos del Motor, fuera del repositorio y de la Base
personal. Windows local, Node.js 24.18.0 y Python 3.12: **38 pruebas JavaScript +
10 nativas aprobadas, 0 fallos y 0 omitidas**.

Las pruebas nativas usan barreras deterministas dentro del mismo algoritmo para
renombrar la raíz y una subcarpeta después de adquirir sus referencias; conservan
el contenido autorizado. Insertan un enlace antes de abrir el siguiente componente
y verifican rechazo. Reemplazan y eliminan el archivo después de abrirlo y leen el
original por su descriptor. Comprueban desaparición antes de abrir, ausencia de
enumeración y apertura exclusiva del contenido solicitado. ACL reales de Windows
(solo sobre un archivo temporal) y modos POSIX prueban denegación del SO. Se
simula además un fallo de E/S después de bytes parciales y se exige salida vacía.
En Windows se usan junctions reales, que no requieren privilegios de symlink;
macOS/Linux prueban symlinks de archivo y FIFO además de enlaces de directorio.

La suite JavaScript comprueba la autorización no falsificable por nombre/ruta/id,
no transferencia entre identidades o instancias, un solo intento concurrente,
revocación, retirada y nuevo registro, compatibilidad v1, UTF-8, BOM, NUL, límite,
archivos vacíos, originales intactos y fallo cerrado si falta Python. Incluye las
27 pruebas de regresión. Los resultados finales multiplataforma se reflejan en
los checks del SHA de la PR; no se infieren del resultado local.

## Qué conseguiremos después — propuesta sin implementar

Conectar un agente real a esta lectura mediante un adaptador mínimo que traduzca
la identidad y la autorización del usuario a la capacidad ya disponible. Permitirá
solicitar y recibir un texto mediante esa integración, conservando la API
administrativa en el anfitrión. Requiere autorización para otro incremento.

## Referencias técnicas

- [Python: `os.open`, `dir_fd` y disponibilidad](https://docs.python.org/3.12/library/os.html#os.open).
- [POSIX `openat` y referencias estables](https://www.man7.org/linux/man-pages/man2/open.2.html).
- [Microsoft: `NtCreateFile`, `RootDirectory` y `FILE_OPEN_REPARSE_POINT`](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile).
- [Microsoft: apertura de reparse points](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

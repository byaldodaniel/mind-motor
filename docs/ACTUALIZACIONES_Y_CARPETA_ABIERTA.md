# Actualización al iniciar y carpeta abierta

Decisión de Aldo del 2026-11-02: opción A y opción 1; distribución mediante GitHub.
Implementación sobre `d9b4a40`, en una rama separada del candidato de la PR #21.

## Experiencia de uso

Al iniciar Mind para trabajar, el iniciador consulta el canal estable público:
`https://github.com/byaldodaniel/mind-updates/releases/latest/download/stable.json`.
Si hay una versión estable posterior para su plataforma, descarga y verifica el
paquete, lo instala sin pedir confirmación y arranca con el runtime nuevo.
No se instala durante una sesión activa. Sin conexión, con un canal todavía sin
versiones o ante una descarga inválida, se conserva la versión instalada.
La consulta tiene un límite de 5 segundos; la descarga, 120 segundos y 512 MiB.
Las órdenes de versión, ayuda y actualización manual no consultan el canal.

La firma Ed25519 del canal vincula versión, plataforma, URL, tamaño y SHA-256 de
cada paquete. La clave pública viaja con Mind. La privada permanece fuera del
repositorio y nunca se publica. No se necesitan certificados de firma de pago.
El actualizador comprueba además el manifiesto interno, la compatibilidad de la
Base y el arranque del Motor. Una instalación fallida intenta restaurar la
versión anterior. Un fallo de restauración detiene el inicio y se informa.

## Abrir una carpeta

Orden de preferencia para determinar la carpeta de trabajo:

1. `mind mcp --carpeta <ruta-absoluta>` en la configuración del iniciador. Se puede
   repetir para varias carpetas. Es configuración del cliente, no de herramientas.
2. Raíces MCP que comunica el cliente mediante `roots/list`, si las admite.
3. Directorio desde el que el cliente lanzó Mind, si es una carpeta de trabajo
   válida. No se usa como proyecto la carpeta del programa, la Base ni el home.

En ese ámbito se permite encontrar, leer, crear, modificar y organizar sin
formularios adicionales. La continuidad de la Base también queda disponible.
La continuidad sigue siendo la de esa Base; este cambio no la separa por proyecto.
El acceso automático dura la sesión, no queda como permiso global para otros
clientes. Los índices y el registro de carpetas sí son persistentes. Se conservan
las exclusiones existentes y las comprobaciones de rutas y archivos del Motor.
Un cambio de raíces retira el ámbito anterior; una lista vacía o un error al
obtenerlas cierra el ámbito automático. Las operaciones ya iniciadas no se cancelan.

Pedir una ruta en una herramienta no amplía el ámbito abierto. En modo carpeta
abierta, para otra ubicación se indica abrirla en el agente. Los clientes que
no comunican una carpeta válida conservan el flujo manual anterior; su iniciador
debe configurarse con `--carpeta` para obtener esta experiencia sin formularios.
Las autorizaciones manuales preexistentes no se borran de la Base.
Se conserva la confirmación al borrar y al vaciar la papelera.

## Publicar una actualización

El código fuente permanece en el repositorio privado `mind-motor`. El repositorio
público `mind-updates` contiene únicamente información de distribución, paquetes
portables y el canal firmado. Descargar y comprobar el canal no requiere cuenta.

1. Construir y validar los cinco paquetes de la misma versión estable mediante
   `scripts/construir-paquetes.mjs --version-paquete <versión> --salida <carpeta>`.
   Los artefactos contienen solo archivos versionados: incluir el commit completo
   de esta implementación antes de construir.
2. Firmar con:
   `node scripts/firmar-actualizacion.mjs <versión> <clave-privada.pem> <carpeta-paquetes> <stable.json>`.
   El script verifica cada paquete, su versión, los cinco destinos y la clave.
3. Crear una release en borrador con tag `v<versión>` en `byaldodaniel/mind-updates`;
   subir los cinco paquetes y `stable.json`. Revisar y publicar como versión
   estable más reciente. Las instalaciones la detectarán en su próximo inicio.

Las versiones preliminares nunca se distribuyen automáticamente por este canal.
Una instalación anterior a este mecanismo necesita recibir una vez un paquete
que lo incluya. Un ZIP ya descargado no puede modificarse remotamente por sí solo.
La clave privada debe conservarse también en un respaldo protegido del titular;
su pérdida impediría firmar versiones para las instalaciones con esa clave pública.

## Comprobaciones y alcance

Las pruebas nuevas cubren la firma, hash, tamaño, URL, versión, plataforma,
desconexión, instalación real entre productos ficticios mediante proceso separado,
arranque y conservación de la Base, carpeta del iniciador y del directorio de
inicio, raíces MCP cambiantes, permisos entre sesiones, exclusiones y borrado.
No equivalen a una sesión real en cada cliente ni a ejecutar paquetes en macOS/Linux.
El producto base sigue siendo candidato: este trabajo no declara cerrados los
pendientes generales de `AVANCE.md` ni publica por sí mismo una versión estable.

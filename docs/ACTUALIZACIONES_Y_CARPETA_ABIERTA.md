# Actualización al iniciar y carpeta abierta

Alcance de primera publicación: Windows x64; Linux y macOS se publicarán después.
Las plataformas exigidas están en `packaging/publicacion.json`.

Decisión de Aldo del 2026-11-02: opción A y opción 1; distribución mediante GitHub.
Implementación sobre `d9b4a40`, en una rama separada del candidato de la PR #21.

## Experiencia de uso

Implementación de actualización asistida (rama de desarrollo, 14-nov-2026):

1. El Motor consulta solo el canal firmado después de escuchar, a los veinte
   segundos y después cada seis horas. El arranque no descarga el ZIP.
2. La ficha firmada contiene nombre, resumen, cambios, importancia e impacto de
   datos; el firmante deriva formatos, tamaños y grupos del ZIP. Con --anterior
   rechaza declarar Base sin cambios si cambia baseFormatVersion.
3. El aviso sale una vez por conexión y entrega; sin conexión, como máximo cada
   doce horas. actualizacion_consultar cruza lo declarado con la Base y el disco;
   actualizacion_posponer admite 1, 3 o 7 días (seguridad: uno como máximo).
4. actualizacion_aplicar pide un formulario, o devuelve un código para una segunda
   confirmación expresa. La autorización liga versión, revisión, protocolo y hashes
   exactos del manifiesto y ZIP; el código vence a los quince minutos y se consume
   una sola vez. El canal se vuelve a verificar antes de lanzar el relevista.
5. El relevista copia código, Node y Python a Sistema/Actualizaciones/Relevos/<id>
   y se enciende con launchIndependent. Descarga reanudable y prepareOnly dejan el
   Motor atendiendo mientras se verifica y extrae el ZIP.
6. Tras la quietud de todos los chats, relevo.json marca aplicando antes de pedir
   apagar con soloSiQuieto. Iniciadores, puentes y consola esperan la barrera; no
   recuperan una transacción viva ni encienden otro Motor durante la sustitución.
7. La transacción conserva una copia durable de los persistentes de la Base antes
   de la verificación. El programa instalado se prueba con su propio Node y Python
   en un Motor restringido, sobre la Base real. No publica un conector ni admite
   herramientas normales. Se cierra antes de confirmar o recuperar la transacción.
8. Sin cambio de formato, los persistentes deben conservar exactamente sus hashes.
   Si cambia el formato se admite migración, respaldada por la copia previa. Ante
   fallo o corte se restaura archivo a archivo, también en una Base externa.
9. El acta persiste fuera de la Base, aparece una vez por conexión y los fallos se
   muestran. Los snapshots de relevista solo se limpian tras comprobar que su dueño
   terminó; una identidad no verificable conserva la recuperación.

El estado de descarga sigue en Sistema/Actualizaciones/estado.json (formato 2,
último error separado de la fase). La publicación del candidato sigue la política
del proyecto; estas pruebas no promueven por sí solas el canal estable.

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

1. Construir y validar los paquetes de las plataformas publicadas de la misma versión estable mediante
   `scripts/construir-paquetes.mjs --version-paquete <versión> --salida <carpeta>`.
   Los artefactos contienen solo archivos versionados: incluir el commit completo
   de esta implementación antes de construir.
2. Firmar con:
   `node scripts/firmar-actualizacion.mjs <versión> <clave-privada.pem> <carpeta-paquetes> <stable.json> --novedades <ficha.json> --anterior <estable.zip>`.
   El script verifica cada paquete, su versión, los destinos publicados y la clave.
3. Crear una release en borrador con tag `v<versión>` en `byaldodaniel/mind-updates`;
   subir los paquetes de las plataformas publicadas y `stable.json`. Revisar y publicar como versión
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

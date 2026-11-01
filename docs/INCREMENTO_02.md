# Incremento 02 — carpetas autorizadas

## Cierre del Incremento 01

La PR #1 se integró después de comprobar que conservaba el commit revisado
`c3e5d7cc4b9c76f18d8553156d366ab50837053b`, las seis comprobaciones de sus dos
workflows seguían aprobadas y no existían conflictos. El Motor local se sincronizó
por avance rápido con `main`, commit de integración
`c602385d0cb15945844db5037524c9cd92d7c7b6`, antes de crear la rama del Incremento 02.

## Qué se implementó

- Registro explícito y consulta de carpetas autorizadas por el usuario local.
- Retirada por identificador, incluso si la carpeta ya no existe.
- Persistencia en archivos de metadatos independientes dentro de la Base externa.
- CLI `folder-add`, `folder-list` y `folder-remove`.
- Validación de rutas absolutas, existentes, accesibles y disjuntas del Motor/Base.
- Resolución de alias al registrar, sin autorizaciones duplicadas para una misma ruta física.
- Precomprobación de alcance para futuras operaciones; rechazo de rutas fuera del
  ámbito, enlaces estáticos que escapan de él y una raíz redirigida.
- No se enumeran las carpetas autorizadas ni se abre el contenido de sus archivos.
- No se implementa un sistema de agentes ni se les concede acceso implícito.

La escritura JSON, los errores y las comparaciones de rutas del núcleo actual se
comparten con las nuevas operaciones. Solo se reutiliza el Incremento 01 de Mind
1.0, sin recuperar ninguna implementación anterior. No se añadieron dependencias.

## Pruebas locales

Windows, Node.js v24.18.0: `node --test`, **27 aprobadas, 0 fallos y 0 omitidas**:
11 de regresión del núcleo y 16 de carpetas. Se verifican registro, duplicados,
consulta, retirada, procesos separados/reinicio, Bases independientes, originales
ficticios intactos, ubicaciones inválidas, fallo de acceso, límites por rutas/enlaces,
retirada visible en instancias abiertas, metadatos corruptos, concurrencia entre
carpetas distintas y ausencia de recorrido de los originales.

La denegación de acceso se prueba mediante un fallo EACCES simulado y controlado,
para no modificar ACL del equipo ni depender de privilegios especiales. Las pruebas
usan solo carpetas y datos ficticios temporales, fuera de Git y dentro del entorno
de desarrollo. El resultado en Windows/macOS/Linux de GitHub Actions se muestra
en los checks de la pull request; no se anticipa en este documento.

## Límites

Los metadatos registran ubicaciones y no acreditan identidad de un agente. La
precomprobación de alcance no resuelve sustituciones de rutas entre comprobación y
uso; todavía no existe apertura de archivos originales. La Base y el proceso local
se consideran de confianza. No hay transacciones concurrentes para registrar y
retirar la misma carpeta; esas operaciones se deben realizar en secuencia.

## Qué podremos construir después

Una lectura puntual de un archivo de texto dentro de una carpeta registrada,
verificando además el permiso explícito de quien solicita la operación. Su alcance,
la apertura segura y las pruebas se definirán en el siguiente incremento autorizado.
No se implementa con este cambio.

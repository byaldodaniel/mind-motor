# Entrega correctiva universal de Mind 1.0.3

Mind conserva la versión pública **1.0.3**. La entrega original corresponde a la revisión técnica 0; esta corrección usa revisión 1, layout 2 y protocolo de actualización 2. Se distribuye un único ZIP actual, `Mind-1.0.3-universal-r1.zip`, con raíz `My Mind/` y los cinco destinos declarados. Las copias anteriores se conservan como evidencia; no se sobrescriben sus bytes ni respaldos.

## Preparación y pruebas

1. Recuperar en Mind la ficha existente de 1.0.3 y la política `mind-publicacion-versiones`. Registrar la revisión, commit, alcance, recuperación y evidencias dentro de esa misma ficha. Comprobar o completar el respaldo remoto verificado de la entrega original antes de publicar.
2. Trabajar en rama y PR, sin modificar la instalación personal. Ejecutar las pruebas de sesiones/PID, actualización, firmas, transacciones y layout sobre datos ficticios. Distinguir sesiones activas, abandonadas y no verificables; nunca cerrar procesos ajenos por un PID guardado.
3. Construir desde el commit limpio comprobado con `scripts/construir-paquetes.mjs`, `--clave-publicacion <clave privada protegida>` y salida nueva. La firma del descriptor se incorpora durante la construcción y autentica los bytes del manifiesto. Dos construcciones finales con los mismos insumos deben ser idénticas. La clave privada no entra en el repositorio, ZIP, informes ni CI.
4. Validar el único ZIP final con `scripts/firmar-actualizacion.mjs --verificar 1.0.3 <candidatos>`. Comprobar raíz, revisión, composición, licencias, permisos, presupuesto, firma y huellas. El ZIP lleva `Sistema/entrega-firmada.json`; una candidata sin ese descriptor firmado no es publicable.
5. La prueba real de actualización `scripts/producto-actualizacion-automatica.mjs` acepta una copia layout 2 y un paquete de la misma versión pública con revisión superior. El transporte HTTPS del ensayo y su firma de canal usan una clave efímera. El paquete de ensayo se construye con revisión técnica superior mediante `--revision-paquete`, con clave de prueba; nunca se firma un ensayo de revisión superior con la clave de producción ni se publica. Las pruebas de migración legacy usan la orden `corregir`, no el actualizador antiguo.
6. Ejecutar la batería funcional una vez en el entorno disponible, identificándolo en el informe. Verificar composición e integridad de todos los destinos del ZIP; no exigir cinco ejecuciones nativas como condición genérica de entrega. Ejecutar compatibilidad específica cuando un cambio o fallo concreto lo justifique.

El flujo histórico `preparar-paridad.mjs` no prepara esta corrección: espera el layout y nombres anteriores y eleva la versión pública del ensayo. En esta entrega se usa la construcción directa anterior, con verificación reproducible y ensayos por revisión separados del candidato final. No presentar el flujo histórico como aprobado para layout 2.

## Transición de las copias existentes

Los clientes ya distribuidos no saben comparar revisiones de la misma versión y algunos confunden PID reutilizados con sesiones activas. Tampoco pueden reiniciar correctamente un paquete que cambie las rutas del programa. No basta sustituir el ZIP de una URL para corregirlos.

La transición se realiza una vez mediante el agente: descarga el ZIP correctivo oficial, verifica su descriptor con la clave pública ya confiada en la copia anterior y comprueba el manifiesto y todos sus archivos **antes de ejecutar código nuevo**. Para esa verificación previa puede usar el runtime y las primitivas criptográficas de la copia anterior. Un hash incluido en el propio ZIP no sustituye esta autenticación. No obtener la clave de confianza del paquete que se está comprobando.

Después ejecuta el código corregido desde el paquete extraído fuera de la copia objetivo, mediante `mind corregir <copia existente> --paquete <carpeta nueva>`. El reparador prepara la transacción y espera las sesiones reales; una sesión no verificable requiere resolver su identidad, no borrarla por antigüedad. Mantiene la ruta anterior, los datos y las reglas ajenas. El nombre My Mind es el predeterminado para nuevas extracciones, no una orden de renombrar instalaciones existentes.

La migración y las siguientes actualizaciones conservan un diario durable. Se comprueban interrupciones en cada fase, recuperación, reutilización de componentes iguales y ausencia de acumulación tras actualizaciones sucesivas. Una limpieza pendiente se informa expresamente y se reintenta; no se descarta una recuperación necesaria ni se llama fallo de instalación a una actualización ya confirmada.

## Canal y publicación

El canal firmado usa `format: mind-update`, `version: 2`, versión pública, revisión técnica, layout, protocolo y SHA-256 del manifiesto, con un único paquete universal. Los clientes antiguos rechazan el protocolo nuevo antes de intentar una sustitución incompatible. Los corregidos comparan versión y revisión y rechazan otro manifiesto con la misma identidad.

El canal principal sigue siendo el origen configurado y firmado. Distinguir DNS, permisos del proceso, HTTP, tiempo agotado, firma, compatibilidad y sesiones. Los reintentos son acotados y persistidos; una copia mantiene una operación y reutiliza su descarga preparada. No ampliar permisos ni configurar el cliente manualmente para resolver una restricción del entorno.

Para la publicación final, generar `stable.json` desde el ZIP definitivo con el firmador y la clave de producción. Preparar borrador con ZIP, sumas, canal y notas; revisar el candidato concreto y aplicar las autorizaciones vigentes. Promover solo cuando los pasos previos de la política estén verificados. Actualizar el sitio y comprobar desde las direcciones públicas que descarga, firma, hash, versión y revisión corresponden al mismo artefacto.

Una restauración del canal no revierte equipos ya actualizados. Conservar los artefactos y registrar el incidente; la recuperación de esta entrega mantiene la versión pública decidida por Aldo y requiere una revisión correctiva explícita. Cerrar la ficha solo después de publicación, sitio, comprobación pública y continuidad verificados.
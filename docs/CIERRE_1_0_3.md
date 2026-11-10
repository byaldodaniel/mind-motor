# Mind 1.0.3 — corrección de distribución

La versión pública se mantiene en 1.0.3; packageRevision 1 identifica la entrega corregida. Un ZIP universal, raíz My Mind, listo al extraer. Sistema separa Programa, Componentes, Base, Licencias, Estado y Actualizaciones; Conversaciones continúa siendo el destino predeterminado de los resultados.

## Copias existentes

Las copias públicas anteriores no pueden adoptar esta estructura por sí solas: algunas confunden PID reutilizados con sesiones y la 1.0.3 original ignora una revisión con el mismo número. El agente aplica una sola vez la entrega corregida a la ruta existente mediante `mind corregir <copia> --paquete <carpeta nueva>` ejecutado desde el paquete nuevo, fuera de la instalación objetivo. No se renombra la carpeta anterior ni se exige al usuario configurar MCP o copiar comandos. Las sesiones reales deben terminar normalmente; no se cierran procesos ajenos.

Antes de ejecutar código del paquete nuevo, el agente descarga el ZIP oficial y verifica el descriptor Ed25519 con la clave ya fijada en la instalación anterior, usando su runtime confiado. El descriptor firma la identidad de entrega y SHA-256 exacto del manifiesto. Después comprueba todos los archivos, tipos, rutas y huellas. No acepta como ancla una clave suministrada por el paquete que intenta verificar. La orden corregir repite esa verificación antes de modificar la copia.

El canal firmado de protocolo 2 incluye versión, revisión, estructura y SHA-256 del manifiesto. Una revisión superior se instala una vez; misma identidad con contenido distinto se rechaza. Los clientes antiguos rechazan el contrato incompatible sin intentar instalarlo.

## Operación y limpieza

Una transacción por instalación: comprobar, descargar, preparar, esperar sesiones, sustituir, verificar, confirmar y limpiar. Un PID existente no acredita identidad; los propietarios se clasifican en activos, abandonados o no verificables mediante información nativa. La falta de permisos o metadatos no permite borrar una sesión.

El diario se conserva solo mientras la operación necesita recuperación o limpieza. Antes de confirmar se puede restaurar; después se termina la limpieza, sin volver a la entrega anterior. No quedan versiones anteriores ni un almacén de paquetes históricos en el equipo del usuario. Componentes idénticos se reutilizan. Los respaldos personales y archivos desconocidos se conservan.

## Aceptación

Programa universal completo como máximo 1.10 GiB lógicos y 4500 archivos, excluyendo datos y temporales de una operación activa. Los cinco destinos y sus licencias están incluidos. Python conserva biblioteca estándar y extensiones usadas; los alias ejecutables son iniciadores exec, sin enlaces obligatorios ni copias completas del intérprete.

Pruebas sobre datos ficticios: PID reutilizado y sesión real; permisos insuficientes; carreras; migraciones desde 1.0.2 y 1.0.3 original; cortes antes/después del commit; tres actualizaciones sin acumulación; conservación de Base, destinos y configuración. Informar el entorno realmente ejecutado y verificar composición de los demás destinos, sin afirmar pruebas nativas inexistentes.

El archivo histórico de entregas pertenece al desarrollo y a su respaldo privado verificado en nube. Se reutiliza la ficha 1.0.3, añadiendo la revisión correctiva y las evidencias. La publicación conserva el artefacto original y expone una única descarga actual con sus huellas y firma coincidentes.

# Actualizaciones y carpeta abierta — comprobación local en Windows

Fecha del usuario: 2026-11-02, America/Lima.
Base de código: `d9b4a40`, rama de integración de la PR #21.
Todos los archivos y las Bases usados en las pruebas son ficticios y temporales.

## Resultado

- Suite JavaScript final: 307 pruebas, 304 aprobadas, 2 omitidas y 1 fallo.
- Suites Python: 50 pruebas, 47 aprobadas y 3 omitidas.
- El fallo corresponde a `test/organize-agent.test.js`, prueba «dos movimientos
  simultáneos del mismo archivo: solo uno ocurre y nada se pierde».
  Dos movimientos sobre la misma ruta pueden devolver ambos éxito en Windows.
  Se reprodujo en el primer intento al ejecutar esa misma prueba en un clon
  intacto del código original `d9b4a40`, sin estos cambios.
  Registrar como pendiente del frente de organización; no declarar la suite verde.
- Las pruebas nuevas de actualización automática, firma y acceso por carpeta,
  así como las de actualización existentes, pasaron en la suite final.
- Se comprobó la instalación desde un canal firmado simulado en dos productos
  ficticios, descarga y archivo comprimido, instalador en otro proceso,
  comprobación real de arranque y conservación byte a byte de la Base.
- Se comprobó el bloqueo por sesiones activas, incluidas las que usan otra Base
  en la misma instalación, y el inicio de una sesión mientras se actualiza.
- Se comprobaron las raíces MCP y sus cambios, directorio de inicio y `--carpeta`,
  lectura, creación y continuidad sin formularios, rechazo fuera del ámbito,
  exclusiones, reducción de permisos y confirmación al borrar.

Las primeras pruebas dentro del entorno restringido no pudieron abrir carpetas
con los auxiliares nativos de Windows. Se repitieron con el usuario del equipo
sobre datos ficticios; los resultados de arriba corresponden a esas ejecuciones.

## Pendientes para distribución estable

- Resolver el fallo de concurrencia preexistente en el frente de organización.
- Ejecutar la validación del cambio y de los paquetes en Linux y macOS.
- Comprobar la experiencia con clientes reales; las pruebas de raíces simulan
  el protocolo, no prueban que cada cliente comunique su carpeta automáticamente.
- Construir, revisar y publicar los cinco paquetes de una versión estable y el
  canal firmado. El repositorio público no contiene todavía una versión estable.
- Las instalaciones antiguas necesitan recibir una vez un paquete puente.

La instalación personal de My Mind no fue actualizada como parte de estas pruebas.

## Entrega y CI

- PR en borrador: https://github.com/byaldodaniel/mind-motor/pull/22
- Canal público creado: https://github.com/byaldodaniel/mind-updates
- Tras subir la rama, GitHub no inició los jobs: la anotación de Actions informa
  de pagos fallidos recientes o de un límite de gasto que debe aumentarse.
  Por tanto, los checks remotos fallidos no representan ejecuciones de pruebas;
  las comprobaciones de esta entrega siguen siendo las locales en Windows.

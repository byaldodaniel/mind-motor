# Instrucciones para trabajar en Mind 1.0

## Carpeta abierta y actualizaciones asistidas

La carpeta de trabajo que comunica el cliente, el iniciador con `--carpeta`, o
su directorio de inicio válido tiene acceso completo durante la sesión, sin otro
formulario de Mind. Para trabajar con otra ubicación, ábrela en el agente.
Las confirmaciones al borrar y vaciar la papelera se conservan.
Si el cliente no comunica una carpeta válida, configura su iniciador con
`mind mcp --carpeta <ruta-absoluta>`; el flujo manual sigue disponible.
El Motor Central consulta el canal estable en segundo plano y el agente avisa una
vez por conversación. Usa actualizacion_consultar para explicar la entrega y
actualizacion_posponer si el usuario pide recordarla después. Solo ante una petición
expresa de aplicar, usa actualizacion_aplicar: el usuario confirma en el formulario
o en dos pasos con un código ligado a la entrega. Mind prepara con el Motor vivo,
espera la quietud de todos los chats y comunica el acta, incluidos los fallos.
Sin conexión continúa con la versión instalada.


- Construir desde cero usando `docs/Concepto_Mind.pdf` como referencia conceptual.
- No importar código, pruebas, estructuras ni configuraciones de versiones anteriores.
- No implementar funciones fuera del incremento solicitado.
- Mantener la Base de pruebas fuera del repositorio y separada de la instalación personal.
- Usar únicamente datos ficticios en las pruebas y no versionar credenciales ni datos personales.
- Conservar intactos los respaldos históricos.
- Trabajar mediante ramas y pull requests; indicar qué se comprobó y qué queda pendiente.

## Uso selectivo de Mind

Mind es opcional. Los agentes pueden utilizarlo cuando aporte valor y recurrir
directamente a otras herramientas cuando sea suficiente, respetando siempre las
autorizaciones aplicables. Usar otra herramienta no amplía los permisos del agente.
No construir un gestor adicional para aplicar esta decisión.

## Lectura de originales

- El anfitrión de confianza conserva la API administrativa. Solo él concede un
  permiso de lectura tras una autorización explícita del usuario.
- Un agente recibe únicamente su función de lectura ligada a su identidad opaca
  y el permiso para el archivo concreto; no la instancia administrativa del Motor.
- Ni el id de carpeta, ni una ruta, ni un nombre de agente constituyen un permiso.
- No sustituir la apertura por descriptores por `checkFolderScope` seguido de una
  apertura convencional. Si falta el auxiliar seguro, denegar la operación.

## Módulos integrados

- `indexFolder(id)` y `readFolderIndex(id)` son operaciones administrativas del
  anfitrión. No entregarlas a agentes junto con su función de lectura de originales.
- Resolver ámbitos exclusivamente con el registro de carpetas del Motor. No
  introducir rutas proporcionadas por agentes ni otro sistema de permisos.
- Retirar una carpeta revoca primero el registro y después elimina su índice.
  Los índices deben conservar el vínculo a la generación del registro, también
  para rechazar publicaciones tardías de una autorización anterior.
- Continuidad y definiciones de funciones permanecen como módulos internos.
  Integrarlos no concede a agentes acceso a sus registros ni ejecución de funciones.

@AGENTS.md

## Carpeta abierta y actualizaciones asistidas

La carpeta de trabajo que comunica el cliente, el iniciador con `--carpeta`, o
su directorio de inicio válido tiene acceso completo durante la sesión, sin otro
formulario de Mind. Para trabajar con otra ubicación, ábrela en el agente.
Las confirmaciones al borrar y vaciar la papelera se conservan.
Si el cliente no comunica una carpeta válida, configura su iniciador con
`mind mcp --carpeta <ruta-absoluta>`; el flujo manual sigue disponible.
El Motor Central consulta el canal estable en segundo plano y el agente avisa una
vez por conversación. Usa actualizacion_consultar para explicar la entrega,
actualizacion_posponer si el usuario pide recordarla después y actualizacion_aplicar
solo ante petición expresa. Sin conexión continúa con la versión instalada.

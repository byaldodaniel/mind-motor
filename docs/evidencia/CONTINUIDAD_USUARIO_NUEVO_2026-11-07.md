# Continuidad: usuario nuevo y traslado — 2026-11-07

Ensayo de aceptación en Windows x64 con datos ficticios. El objetivo es que el usuario empiece con los valores predeterminados y pueda trasladar una conversación conservando decisiones, archivos e identidad. La web y la optimización semántica quedan fuera de este ensayo.

## Preparación aislada

El script `scripts/probar-continuidad-nueva.mjs` crea una instalación nueva temporal copiando el código del checkout y los runtimes nativos incluidos. No copia la Base ni las conversaciones personales. `HOME`, `USERPROFILE` y `CODEX_HOME` apuntan a un perfil ficticio. No se modifican las instrucciones globales personales.

También acepta `--mind <producto extraído>` para repetir el mismo recorrido desde una copia de un paquete. El ensayo aquí registrado usa una instalación ficticia desde el checkout: no certifica todavía el ZIP universal final.

## Aceptación del motor por MCP

Resultado: **cuatro fases aprobadas**, sin formularios ni elecciones de destinos iniciales.

1. `inicio` prepara tres perfiles ficticios y devuelve `Mind/Conversaciones`, modo esencial y ninguna preferencia de destino configurada.
2. Un primer cliente guarda la decisión de preparar 23 muestras para el martes y el pendiente de confirmar el vehículo. Crea un documento y registra una imagen PNG real, todos en el almacén predeterminado.
3. Un segundo cliente traslada el elemento con `conversacion_trasladar` a un proyecto abierto y después renombra la carpeta con `mover`. El ID se conserva; memoria, documentos, imagen y destinos efectivos apuntan a la ubicación nueva. Los originales se conservan como recuperación.
4. Un tercer cliente busca y recupera el mismo ID. Corrige la decisión a 31 muestras para el lunes, mantiene el pendiente y los archivos, y crea el siguiente resultado en la carpeta nueva. La memoria original queda intacta y la carpeta intermedia no vuelve a crearse.

Integridad del PNG antes y después: SHA-256 `21f8f7f6bfad14d99cbd0d97bef61fc2b8b4e885fe57357af51c8c6d13301ba9`. El documento también se compara por bytes y SHA-256.

Informe conservado: `C:\Users\Aldo Daniel\Desktop\Mind - Desarrollo\Borradores\2026-11-07 - Continuidad simple\Aceptacion\continuidad-mcp.json`, resultado superado. Huella agregada de los 100 archivos de código de esa instantánea: SHA-256 `d6d22cddc1053f2c0dddb84d142b837f68393ef171defc7d78418f3fb8fb2db2`.

## Cliente real

La prueba opcional `--codex` usa tres conversaciones independientes de Codex CLI en un perfil ficticio. Los prompts no nombran Mind ni proporcionan sus comandos. La primera conversación abre la carpeta nueva de Mind con los `AGENTS.md` y `LEEME.md` de distribución y el iniciador incluido, **antes de ejecutar `inicio` o `preparar` desde el controlador**. El perfil solo tiene la autenticación temporal necesaria para usar el modelo: aún no tiene instrucciones globales de Mind. El agente debe descubrir el iniciador a partir de las instrucciones de la carpeta.

Resultado: **aprobado, cinco fases de aceptación y tres turnos nativos**.

1. Codex descubre el iniciador al abrir Mind, prepara el inicio y crea la nota Markdown, el SVG y la memoria esencial de Aurora en el almacén predeterminado. El acuerdo es 12 muestras para el jueves; confirmar el embalaje queda pendiente. El usuario no elige rutas ni edita configuración.
2. Una conversación nueva desde otro proyecto consulta `inicio` por las reglas globales generadas y traslada memoria y resultados a `Aurora trasladada`. El ID `50de9e49-fdd1-468e-a4a7-1832bfff33ec` se conserva y ambos resultados coinciden por SHA-256.
3. Otra conversación recupera el mismo elemento y responde 12, jueves, embalaje y las rutas vigentes, sin crear otro registro.

Informe y registros conservados: `C:\Users\Aldo Daniel\Desktop\Mind - Desarrollo\Borradores\2026-11-07 - Continuidad simple\Aceptacion\continuidad-codex.json` y `codex-nuevo-1.jsonl` a `codex-nuevo-3.jsonl` en la misma carpeta. `sanitizacion.json` registra las huellas y la comprobación de patrones de credenciales: cero coincidencias. La copia temporal de autenticación fue retirada y todas las instalaciones y perfiles ficticios se eliminaron tras verificar el resultado. Su contenido no se escribe en los informes.

La instantánea del ensayo nativo precede a los ajustes de validación de traslados repetidos/al mismo destino. La comparación de código está registrada en `Aceptacion/snapshot-codigo.json`; el ensayo MCP posterior antes citado comprueba la instantánea posterior. No se presenta la ejecución del modelo como prueba de esas ramas de reintento. La adaptación posterior a G:/FAT32 requiere su evidencia propia: este recorrido usa C: y no la certifica.

## Reproducción

Desde el checkout, con el Node incluido en una instalación de Mind:

```powershell
& '<Mind>\Runtime\node\node.exe' scripts/probar-continuidad-nueva.mjs --runtime-root '<Mind>' --informe '<informes>\continuidad-nueva-mcp.json'
& '<Mind>\Runtime\node\node.exe' scripts/probar-continuidad-nueva.mjs --runtime-root '<Mind>' --informe '<informes>\continuidad-nueva-codex.json' --codex
```

## Límites

- El cliente MCP de aceptación simula al agente y solo prueba las operaciones del motor.
- Codex CLI real no certifica la interfaz de escritorio de Codex, Antigravity ni Claude.
- El ensayo no convierte ni mueve el historial nativo del cliente.
- La copia de traslado conserva los originales; eliminarlos es una operación separada que sigue las confirmaciones vigentes.
- No se instaló la 1.0.3 en My Mind, no se publicó una versión y no se modificó la web.

## Regresión y Google Drive

Regresión completa inicial: 420 JavaScript y 62 Python aprobadas, cinco omisiones de plataforma. Después se repitieron las pruebas específicas de reintento y las suites nativas afectadas. El traslado real de C: a G: (DriveFS), el renombrado de carpeta y la continuación desde una tercera sesión aprobaron, conservando decisiones y huellas de los archivos. Ver [evidencia de DriveFS](DRIVEFS_CONTINUIDAD_2026-11-07.md).

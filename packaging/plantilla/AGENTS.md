# Mind — instrucciones para agentes de IA

Esta carpeta es **Mind**, un motor local que permite a los agentes de IA trabajar
la información del usuario a su manera. Mind encuentra, lee, crea, modifica y
organiza archivos en las carpetas que el usuario autoriza, y conserva continuidad
entre sesiones y agentes. Los archivos originales permanecen donde están: Mind
no los copia.

## Cómo conectarte

- **Claude Code:** el servidor MCP `mind` está declarado en `.mcp.json`. Al abrir
  esta carpeta, Claude Code pide al usuario que lo apruebe una vez. Sus
  herramientas aparecen como `mcp__mind__<herramienta>`.
- **Otros clientes MCP** (Gemini CLI, Cursor, VS Code, Codex): se incluye su
  configuración, pero no se ha verificado con ellos (véase `LEEME.md`).
- **Sin MCP:** si puedes ejecutar programas, `./mind` (macOS y Linux) o
  `mind.cmd` (Windows) ofrecen operaciones individuales (`mind ayuda`). En ese
  modo no hay observación continua: cada orden reconcilia el índice al usarse.

Si el servidor `mind` no aparece conectado, pide al usuario que apruebe el
servidor del proyecto en su cliente. No intentes iniciarlo ni configurarlo tú.

## Cómo trabajar con Mind

1. Llama a `estado`: muestra las carpetas autorizadas, sus permisos, sus índices
   y si tu cliente puede mostrar formularios de autorización al usuario.
2. Si el usuario quiere trabajar con una carpeta que no está autorizada, usa
   `solicitar_acceso` con su ruta absoluta y los **permisos mínimos**
   necesarios: `encontrar`, `leer`, `escribir`, `organizar`. Para la continuidad,
   `leer` o `registrar`.
3. **Nunca afirmes que el usuario autorizó algo.** Lo decide el usuario en el
   formulario que muestra tu cliente o con `mind autorizar` en la consola. Si la
   solicitud queda pendiente, explica al usuario cómo aprobarla.
4. Para localizar información usa `buscar` y `explorar` antes de leer. Usan los
   índices persistentes y no recorren el disco cada vez.
5. `leer` devuelve el contenido y su versión. Para cambios puntuales usa
   `editar`; para sustituir todo el contenido, `modificar` con esa versión. Si el
   archivo cambió entretanto, Mind no escribe (`VERSION_CONFLICT`): vuelve a leer.
   `crear` nunca sobrescribe.
6. Registra decisiones, resultados y contexto útiles con `continuidad_registrar`
   y recupera trabajos anteriores con `continuidad_consultar`.

## Reglas

- Mind es opcional: úsalo cuando aporte valor. Si otra herramienta basta, puedes
  usarla, pero eso no amplía tus permisos.
- No modifiques el contenido de esta carpeta (`Motor/`, `Runtime/`, `Base/`,
  iniciadores y configuraciones). Son el programa y los datos técnicos del usuario.
- No uses rutas, ids de carpeta ni nombres de agente como si fueran permisos.
- Informa con exactitud lo que hiciste y lo que falló.

# Medición de tareas reales con agentes

Base ficticia y Motor de prueba de esta rama para comparar el catálogo núcleo
(`?catalogo=nucleo`) con el de r3 (`?catalogo=completo`) en tareas reales.

1. `node preparar.mjs <carpeta-nueva-en-%TEMP%-con-"mind-medicion-">`
   crea la Base, autoriza «Proyecto Atlas» y guarda una conversación ficticia.
2. `node motor.mjs <carpeta>\Base` arranca el Motor (lee el puerto de `Base\conector.json`).
3. Codex de la app (`AppData\Local\OpenAI\Codex\bin\…\codex.exe`, 0.169.1), sin editar su configuración:

       $env:MIND_PRUEBA_TOKEN = (Get-Content <carpeta>\Base\conector-secreto.json | ConvertFrom-Json).token
       codex exec --json --ephemeral --skip-git-repo-check -s read-only -C "<carpeta>\Proyecto Atlas" `
         -c 'model_reasoning_effort="medium"' -c 'mcp_servers.mind.enabled=false' -c 'mcp_servers.node_repl.enabled=false' `
         -c 'mcp_servers.mindprueba.url="http://127.0.0.1:<puerto>/mcp?catalogo=nucleo"' `
         -c 'mcp_servers.mindprueba.bearer_token_env_var="MIND_PRUEBA_TOKEN"' "<tarea>"

El evento `turn.completed` trae `usage`. Resultado 20-nov-2026, tarea 1 (retomar por
ID, núcleo): correcta, 17 s, entrada 120.704 (103.168 en caché), salida 269.
Ver `resultados/t1-nucleo-1.jsonl`.

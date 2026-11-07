# Inicio automático — candidato 1.0.3

El primer uso de una instalación prepara un bloque breve en las instrucciones globales de los clientes detectados. Codex usa AGENTS.md (o su override activo y CODEX_HOME), Claude Code usa .claude/CLAUDE.md y Antigravity usa .gemini/GEMINI.md. Conserva las reglas existentes y no modifica autenticación ni permisos de seguridad. No registra MCP globalmente: usa sus herramientas si están conectadas o el iniciador incluido con inicio desde el proyecto actual.

Pruebas iniciales en Windows x64: seis casos aprobados (tres clientes, preservación/idempotencia, override y perfil alternativo, movimiento de instalación, conflictos/enlaces, opt-out/perfiles ausentes y CLI real desde otro proyecto). La CLI devuelve instrucciones y destinos sin JSON. Son perfiles ficticios; no se presentan como ejecución de modelos reales.

El almacén predeterminado conserva el flujo manual cuando el cliente no abrió un proyecto. Prueba focalizada de inicio, destinos y ámbito: 18 casos aprobados.

La primera regresión completa detectó una carrera al cerrar el índice CSV automático (ENOTEMPTY en limpieza). Se corrigió para esperar regeneraciones en curso y evitar temporizadores de avisos tardíos. Dos pruebas deterministas y doce existentes de propiedades/índices aprobaron. El fallo no se oculta ni se resuelve ampliando tiempos.

Pendientes de esta ficha: regresión final, paquete universal del mismo commit, matriz nativa, prueba de modelo con instrucciones globales sin mencionar Mind en el prompt y distribución según la política. Los resultados finales se incorporarán al cierre; este texto no certifica aún publicación ni instalación personal.

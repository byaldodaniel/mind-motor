# Inicio automático — candidato 1.0.3

El primer uso de una instalación prepara un bloque breve en las instrucciones globales de los clientes detectados. Codex usa AGENTS.md (o su override activo y CODEX_HOME), Claude Code usa .claude/CLAUDE.md y Antigravity usa .gemini/GEMINI.md. Conserva las reglas existentes y no modifica autenticación ni permisos de seguridad. No registra MCP globalmente: usa sus herramientas si están conectadas o el iniciador incluido con inicio desde el proyecto actual.

Pruebas iniciales en Windows x64: seis casos aprobados (tres clientes, preservación/idempotencia, override y perfil alternativo, movimiento de instalación, conflictos/enlaces, opt-out/perfiles ausentes y CLI real desde otro proyecto). La CLI devuelve instrucciones y destinos sin JSON. Son perfiles ficticios; no se presentan como ejecución de modelos reales.

El almacén predeterminado conserva el flujo manual cuando el cliente no abrió un proyecto. Prueba focalizada de inicio, destinos y ámbito: 18 casos aprobados.

La primera regresión completa detectó una carrera al cerrar el índice CSV automático (ENOTEMPTY en limpieza). Se corrigió para esperar regeneraciones en curso y evitar temporizadores de avisos tardíos. Dos pruebas deterministas y doce existentes de propiedades/índices aprobaron. El fallo no se oculta ni se resuelve ampliando tiempos.

Pendientes de esta ficha: regresión final, paquete universal del mismo commit, matriz nativa, prueba de modelo con instrucciones globales sin mencionar Mind en el prompt y distribución según la política. Los resultados finales se incorporarán al cierre; este texto no certifica aún publicación ni instalación personal.

La segunda regresión pasó 400 JS (398 aprobadas, 2 omitidas, cero fallos). Python detectó un cambio rápido de origen de copia no observado mediante os.fstat en Windows. Se corrigió usando FileBasicInfo (tiempos nativos escritos/cambiados, precisión 100 ns) del descriptor seguro, sin una segunda lectura completa del archivo. La prueba repite veinte cambios rápidos de igual tamaño. Se repiten las pruebas nativas y de destinos antes del paquete definitivo; el candidato previo 579b089 se descarta para distribución.

La repetición rápida mostró que los tiempos nativos solos tampoco garantizan detectar cada escritura en Windows. La corrección definitiva abre el origen sin compartir escritura durante la copia: impide cambios concurrentes y rechaza copiar si ya hay un escritor abierto. La lectura normal conserva su comportamiento previo. En POSIX se detectan cambios por descriptor. Veinte intentos rápidos verifican el bloqueo/consistencia y la liberación del origen después de copiar. No se realiza una segunda lectura completa ni se duplica el búfer.

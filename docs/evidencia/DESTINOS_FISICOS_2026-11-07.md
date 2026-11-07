# Destinos físicos y continuidad — 7 de noviembre de 2026

## Resultado y alcance

Implementado en la rama codex/conversaciones-elementos: destinos físicos persistentes generales, por tipo, por proyecto y por conversación; resolución previa a herramientas externas; importación binaria segura; metadatos de resultados recuperables por conversación. Predeterminado de una instalación: Conversaciones junto a Base, creado en la primera sesión, sin carpeta Trabajo. Las actualizaciones preservan ese contenido.

El agente aplica el plan al iniciar. Mind no intercepta escrituras arbitrarias de otras herramientas ni cambia el historial interno de cada cliente. El cliente debe leer y seguir las instrucciones. No equivale a compatibilidad universal ya comprobada.

## Prueba real con Codex

Cuatro ejecuciones independientes de Codex CLI 0.156.1 autenticado, por MCP contra este checkout y una Base ficticia separada de la instalación personal. No se cambiaron configuraciones globales.

1. Configuró un almacén general y otro para imágenes. Guardó acuerdo ficticio Brisa (23 cajas, viernes) y creó Markdown, JavaScript y SVG; importó un PNG binario real.
2. Otro chat recuperó Brisa, corrigió a 31 cajas para lunes y cambió únicamente los nuevos resultados de ese proyecto a otro almacén. Creó CSV y SVG nuevos.
3. Otro chat creó nota y SVG de Aurora: heredó los destinos generales intactos.
4. Otro chat recordó el acuerdo vigente de Brisa, su pendiente y sus seis archivos anteriores/nuevos; contrastó la herencia de Aurora sin escribir.

Verificación independiente en disco: un mismo ID Brisa 2ae40fba-b960-4217-b06b-ea77b4548b92, revisión 3 y el mismo archivo de memoria; seis resultados físicos, archivos regulares con un solo enlace; PNG origen y copia iguales por bytes y SHA-256; preferencia general sin cambios y una sola excepción de proyecto.

Tiempos totales de los cuatro agentes: 89,15 s; 97,05 s; 81,94 s; 50,39 s. Incluyen inferencia, planificación y múltiples operaciones: no son latencias del buscador. El PNG fue un archivo ficticio de prueba, no una imagen generada por un modelo visual. No se probaron todos los generadores de imágenes/video.

Evidencia local externa al repositorio: Borradores/2026-11-07 - Cierre destinos de conversaciones, dentro del frente de desarrollo. Archivos resultado-codex.json, verificacion-fisica.json, codex-rutas-1..4.jsonl y .txt, Base de ensayo y Ensayo real de rutas. No se versionan historiales ni Bases.

## Pruebas automatizadas

- Batería completa: 390 pruebas JS, 388 aprobadas y 2 omitidas; 56 Python, 53 aprobadas y 3 omitidas. Sin fallos. Incluye los cinco casos de destinos y los cinco de copia binaria.
- Verificación posterior de cambios finales: 19 JS, 18 aprobadas y 1 omitida; actualización real preserva hashes de memoria e imagen en Conversaciones; manifiestos no pueden incluir ni enlazar hacia ese almacén.
- Copia por flujo: integridad binaria, publicación exclusiva sin reemplazar, rechazo de enlaces duros/traversal, límite de tamaño, origen alterado sin publicación y protocolo READY antes de efectos.
- Nuevo usuario: crea el almacén junto a Base sin exponer Base, Motor ni Runtime.
- Preferencias: ámbitos/tipos, sesión nueva, conflictos de revisión, destinos externos con permisos vigentes y revocación.
- La memoria JSON y su Markdown siguen siendo dos escrituras: los fallos parciales se informan. Registro de recursos separado para no alterar la revisión de memoria.
- git diff --check sin incidencias.

## Recursos y límites pendientes

La copia usa bloques de 1 MiB y no carga el archivo binario entero en JavaScript. Esto acota el búfer de copia; no se presenta como una reducción medida de toda la memoria del motor. La optimización adicional del modelo semántico no está implementada en este cambio. Las mediciones de búsqueda y memoria del modelo permanecen documentadas en BUSQUEDA_HIBRIDA_2026-11-07.md.

Antigravity abierto y detectado con Gemini 3.8 Flash High: la lectura por accesibilidad funciona. La captura devuelve window capture timed out, y el clic coordinate input geometry is unavailable. Intento de establecer el valor no dejó texto visible en accesibilidad. No se envió la prueba. El usuario aclaró que no pulsaba Escape; avisos anteriores de Escape no deben atribuirse como hecho a su acción. No se valida con esto la nueva versión en Gemini.

Claude Code no queda validado con este incremento; la prueba previa del proveedor devolvió 403 oauth_not_allowed_for_organization. No se cambiaron cuentas ni autenticación para evitarlo.

Instalación personal comprobada: 1.0.2. Este código no se ha publicado ni instalado como estable; faltan paquete universal final y validación de distribución conforme al algoritmo de publicación. No hay algoritmo universal de limpieza, por decisión del usuario.

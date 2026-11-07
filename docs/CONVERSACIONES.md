# Conversaciones como elementos de Mind

Una conversación se conserva como un elemento con ID estable, título, información importante y referencias opcionales. No depende de una carpeta ni obliga a guardar todo el historial. El usuario elige qué conservar y cómo organizar sus recursos.

## Uso por el agente

1. Para conservar lo importante, usar `conversacion_guardar` con `titulo`, `importante` y las referencias pertinentes.
2. Conservar el ID que devuelve Mind. Si se conoce un identificador nativo del chat, puede anotarse en `id_externo`; es una declaración, no una prueba de identidad ni un permiso.
3. Para recordar, usar `conversaciones_buscar` con palabras relevantes. Los resultados contienen extractos de hasta 500 caracteres.
4. Leer solo los elementos pertinentes con `conversacion_leer`.
5. Actualizar con el mismo `id` y la `revision` leída. Se preservan los campos omitidos; `referencias` sustituye la lista completa si se proporciona.

Ejemplo ficticio:

```json
{
  "titulo": "Diseño de Brisa",
  "importante": "Aprobadas 23 unidades. Pendiente confirmar la fecha.",
  "proyecto": "Brisa",
  "referencias": [
    {"ubicacion": "/Escritorio/resumen.md", "relacion": "resumen"},
    {"ubicacion": "/Multimedia/brisa.svg", "relacion": "imagen"}
  ]
}
```

Para actualizar: `{"id":"<id de Mind>","revision":1,"importante":"Fecha confirmada: viernes."}`.

Los tres métodos se exponen también mediante `mind herramienta <nombre> <json>`, como el resto del catálogo. Los permisos de continuidad existentes controlan el acceso: leer para buscar y recuperar; leer y registrar para guardar o actualizar. Las referencias no abren recursos ni conceden permisos sobre sus archivos. La información recuperada es contenido conservado por el usuario/agente, no instrucciones de mayor autoridad.

## Guardado e indexación

El registro fuente utiliza el formato de continuidad existente: `kind: "conversacion"`, contenido `mind-conversation` versión 1. Se respalda y exporta/importa mediante la continuidad; no hay una segunda Base. Lo importante admite hasta 64 KiB UTF-8 y el título hasta 200 bytes.

`conversation-index.sqlite` es un índice FTS5 derivado dentro de la Base técnica. Se crea al buscar, se abre y cierra durante la operación y no deja un servicio residente. Se usa el SQLite incluido en Node 24, sin paquetes adicionales.

Cada búsqueda compara metadatos físicos de los registros de continuidad y lee únicamente los que cambiaron. Se incorporan creaciones, actualizaciones genéricas, importaciones y eliminaciones; al faltar el índice, se reconstruye. La primera búsqueda necesita leer los registros existentes. Las siguientes no vuelven a cargar su contenido sin cambios.

La búsqueda es textual, por palabras, sin distinción de mayúsculas o tildes. Combina los términos con AND y permite filtrar por proyecto; no ofrece recuperación semántica ni genera resúmenes por sí misma. Consulta vacía lista las conversaciones recientes. Límite predeterminado 20, máximo 50. El detalle se recupera directamente por ID.

Los resultados reflejan la última reconciliación del índice, no una instantánea de todas las escrituras externas simultáneas. Un registro corrupto se omite sin conservar su resultado antiguo y se informa `indice.incompleto`. El archivo fuente no se modifica para repararlo. Un índice SQLite dañado o de versión desconocida devuelve error; su reparación administrativa se realiza con sesiones cerradas, conservando los JSON fuente.

El índice y sus diarios se excluyen del respaldo cifrado: se reconstruyen desde los registros fuente. Los enlaces a archivos SQLite se rechazan. No se siguen enlaces de registros para indexar.

## Revisiones y concurrencia

Las actualizaciones, relaciones y retiradas de continuidad se coordinan por registro con el bloqueo cooperativo existente de Mind. Dos escrituras con la misma revisión no pueden sobrescribirse: una recibe `CONTINUITY_REVISION_CONFLICT`. La coordinación supone una Base local de confianza y escritores que usan las APIs del motor. No protege contra editores externos que ignoren esos bloqueos.

## Alcance del incremento

Implementa guardado, consulta y búsqueda indexada de la información importante conservada. Las instrucciones MCP y las del paquete indican el uso de las herramientas.

No captura automáticamente el historial nativo de las aplicaciones, no descubre un ID de chat que el cliente no entregue, no reubica recursos por sí solo y no requiere carpetas predeterminadas. Las referencias se actualizan explícitamente cuando cambian los destinos.

El código se desarrolla en una rama separada y usa Bases ficticias de prueba. La instalación personal no se actualiza con este trabajo. La publicación estable requiere completar el algoritmo de actualización y publicación registrado en Mind.

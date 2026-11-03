# Mind 1.0 — Windows x64

Mind permite a tu agente encontrar, leer, crear, modificar y organizar la
información con la que trabajas. Tus archivos permanecen en su ubicación.
La carpeta `Base` conserva los índices y la continuidad de tus trabajos.

## Empezar

1. **Extrae** el ZIP en la ubicación que prefieras. No necesita permisos de administrador ni instalaciones externas (ya incluye Node.js y Python portables).
2. **Abre tu agente** (Claude Code, Codex, Cursor, Gemini CLI o cualquier otro) sobre la carpeta de Mind y empieza a hablarle. Tu agente leerá `AGENTS.md`, reconocerá las capacidades de Mind de inmediato y empezará a trabajar sin que tengas que configurar nada.
3. **Pídele lo que necesites**: buscar archivos, leer documentos, organizar carpetas o continuar tareas anteriores.

Si abres tu agente directamente sobre otro proyecto, pídele al agente que use Mind indicando su ruta o utilizando `--carpeta "C:\ruta\de\tu\proyecto"`. La carpeta abierta tiene acceso completo para trabajar.

## Conexión técnica (referencia opcional para clientes MCP)

La mayoría de agentes operan automáticamente a través de sus instrucciones. Si utilizas un cliente con configuración manual de MCP por stdio:

- Programa: `<Mind>\Runtime\node\node.exe`
- Argumentos: `<Mind>\Motor\bin\mind.js`, `mcp`
- Variable de entorno: `NODE_OPTIONS` vacía.

Sustituye `<Mind>` por la ruta absoluta donde extrajiste Mind.

Para registrarlo manualmente en Codex CLI desde PowerShell:

    codex mcp add mind --env NODE_OPTIONS= -- "C:\ruta\Mind\Runtime\node\node.exe" "C:\ruta\Mind\Motor\bin\mind.js" mcp

Claude Code descubre `.mcp.json` automáticamente al abrir la carpeta de Mind.

## Qué puedes hacer

- Buscar y explorar mediante índices, mantenidos al día durante la sesión.
- Leer texto y extraer texto de documentos de oficina (solo lectura).
- Crear y modificar texto con control de versión.
- Crear carpetas, mover y renombrar sin reemplazar archivos existentes.
- Borrar con confirmación y recuperar desde la papelera de Mind. Vaciarla
  requiere una segunda confirmación.
- Asignar propiedades, crear índices CSV y conservar continuidad entre sesiones.
- Ejecutar funciones y configurar automatizaciones opcionales.
- Crear respaldos cifrados de la Base mediante `mind respaldo`.

## Actualizaciones

Mind comprueba las nuevas versiones estables al iniciar. Si hay una para Windows,
la descarga, verifica su firma y la instala cuando no haya sesiones activas.
Sin conexión continúa con la versión instalada. Los archivos personales y la Base
se conservan; si la comprobación de arranque falla intenta recuperar la versión anterior.

Una copia anterior al actualizador automático necesita recibir este ZIP una vez.
Con todos los agentes cerrados, usa desde esa instalación:

    mind actualizar "C:\ruta\Mind-1.0.0-win32-x64.zip"

## Alcance y datos

Esta publicación es para Windows x64. Linux y macOS quedan para entregas futuras.
El acceso a la carpeta abierta dura la sesión; las exclusiones se respetan.
Si el cliente no comunica un proyecto válido, sigue disponible el acceso manual
con `mind autorizar`. Se puede revisar con `mind permisos`.

Mind no proporciona aislamiento del sistema operativo. Las operaciones que un
agente realice por otras herramientas tienen los permisos que le dé su equipo.
La Base contiene rutas, metadatos y continuidad: consérvala como información personal.
Los respaldos cifrados no tienen una auditoría criptográfica externa.

Ayuda: `mind ayuda`. Licencia: `LICENCIA.txt`. Componentes: `LICENCIAS/`.

# Mind 1.0 — Windows x64

Mind permite a tu agente encontrar, leer, crear, modificar y organizar la
información con la que trabajas. Tus archivos permanecen en su ubicación.
La carpeta `Base` conserva los índices y la continuidad de tus trabajos.

## Empezar

1. Extrae el ZIP. Conserva la carpeta `Mind` en una ubicación permanente.
   No necesita permisos de administrador; incluye Node.js y Python.
2. Conecta Mind a tu agente una vez (instrucciones abajo).
3. Abre tu carpeta de trabajo en el agente y pídele que use Mind.
   La carpeta abierta tiene acceso completo sin otro formulario de Mind.

Si el agente no comunica la carpeta abierta, configura su servidor con
`mcp --carpeta "C:\ruta\de\tu\proyecto"`. También se reconoce el directorio
válido desde el que el cliente inicia Mind. La carpeta del programa y su Base
están protegidas; abre como proyecto la carpeta que contiene tu información.

## Conectar el agente

Para un cliente MCP con transporte stdio:

- Programa: `<Mind>\Runtime\node\node.exe`
- Argumentos: `<Mind>\Motor\bin\mind.js`, `mcp`
- Variable de entorno: `NODE_OPTIONS` vacía.

Sustituye `<Mind>` por la ruta absoluta donde extrajiste Mind.
Si tu cliente pide confiar en el servidor, esa decisión te corresponde a ti.

Para Codex CLI, registra el servidor una vez desde PowerShell:

    codex mcp add mind --env NODE_OPTIONS= -- "C:\ruta\Mind\Runtime\node\node.exe" "C:\ruta\Mind\Motor\bin\mind.js" mcp

Comprueba primero `codex mcp list`: si ya existe un servidor `mind`, revisa
su ubicación antes de sustituirlo. Reinicia la sesión del agente después del registro.

Claude Code puede descubrir `.mcp.json` al abrir la carpeta de Mind. Para usar
sin formularios otro proyecto, configura Mind como servidor de ese cliente y
abre el proyecto, o añade `--carpeta` con la ruta del proyecto a sus argumentos.
Otros clientes usan la configuración stdio indicada arriba.

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

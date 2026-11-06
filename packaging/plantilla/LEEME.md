# Mind

Mind permite a tu agente encontrar, leer, crear, modificar y organizar la
información con la que trabajas. Tus archivos permanecen en su ubicación.
La carpeta `Base` conserva los índices y la continuidad de tus trabajos.

## Empezar

1. **Extrae el ZIP de Mind** en una carpeta tuya. El mismo ZIP sirve para
   Windows x64, Mac Intel y Apple Silicon y Linux x64 y ARM64 con glibc.
   Mind trae los ejecutores de Node.js y Python y elige el de tu equipo.
2. **Abre la carpeta Mind en tu agente** y pídele que use Mind. El iniciador
   prepara automáticamente la conexión. Si lo abres desde la terminal,
   puedes usar la orden de preparación de la tabla. En Claude Code, vuelve a
   abrir la carpeta si ya estaba abierta antes de preparar la conexión.
3. **Pídele lo que necesites**: buscar archivos, leer documentos, organizar carpetas o continuar tareas anteriores.

Si abres el agente sobre otro proyecto, pídele que use Mind en esa carpeta.
El iniciador acepta `--carpeta` con la ruta absoluta del proyecto. El acceso
completo de la carpeta abierta dura la sesión.

| Sistema | Preparación desde la carpeta Mind | Ayuda |
|---|---|---|
| Windows (PowerShell) | `.\mind.cmd preparar` | `.\mind.cmd ayuda` |
| macOS y Linux | `./mind preparar` | `./mind ayuda` |

En Mac, macOS puede mostrar un aviso al abrir archivos descargados. Consulta
el mensaje del sistema y confirma el origen de tu descarga antes de abrirlos.

## Conexión técnica (referencia opcional para clientes MCP)

Mind genera `.mcp.json` con el programa incluido de tu equipo y la conexión
por stdio. Si tu agente permite configurar MCP manualmente, puedes
consultar ese archivo y resolver sus rutas desde la carpeta Mind. Los
agentes con acceso a terminal también pueden usar el iniciador y las
instrucciones de `AGENTS.md`.

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

Mind comprueba las nuevas versiones estables al iniciar. Si hay una para tu equipo,
la descarga, verifica su firma y la instala cuando no haya sesiones activas.
Sin conexión continúa con la versión instalada. Los archivos personales y la Base
se conservan; si la comprobación de arranque falla intenta recuperar la versión anterior.

Para actualizar manualmente, cierra los agentes y usa el iniciador de la
instalación con `actualizar` y la ruta del ZIP de Mind.

## Alcance y datos

El acceso a la carpeta abierta dura la sesión; las exclusiones se respetan.
Si el cliente no comunica un proyecto válido, sigue disponible el acceso manual
con `mind autorizar`. Se puede revisar con `mind permisos`.

Mind no proporciona aislamiento del sistema operativo. Las operaciones que un
agente realice por otras herramientas tienen los permisos que le dé su equipo.
La Base contiene rutas, metadatos y continuidad: consérvala como información personal.
Los respaldos cifrados no tienen una auditoría criptográfica externa.

Ayuda: `mind ayuda`. Licencia: `LICENCIA.txt`. Componentes: `LICENCIAS/`.

# Mind

Mind permite a tu agente encontrar, leer, crear, modificar y organizar la
información con la que trabajas. Tus archivos permanecen en su ubicación.
La carpeta `Base` conserva los índices y la continuidad de tus trabajos.

## Empezar

1. **Extrae** el archivo que corresponde a tu equipo en una carpeta tuya. Mind
   incluye Node.js y Python. Windows x64 usa ZIP. Mac Intel y Apple Silicon
   y Linux x64 y ARM64 con glibc usan TAR.GZ.
2. **Abre la carpeta Mind en tu agente** y pídele que use Mind. Claude Code
   descubre el servidor incluido. Un agente con terminal puede seguir las
   instrucciones de `AGENTS.md` y usar el iniciador incluido.
3. **Pídele lo que necesites**: buscar archivos, leer documentos, organizar carpetas o continuar tareas anteriores.

Si abres el agente sobre otro proyecto, pídele que use Mind en esa carpeta.
El iniciador acepta `--carpeta` con la ruta absoluta del proyecto. El acceso
completo de la carpeta abierta dura la sesión.

| Sistema | Iniciador desde la carpeta Mind | Ayuda |
|---|---|---|
| Windows (PowerShell) | `.\mind.cmd` | `.\mind.cmd ayuda` |
| macOS y Linux | `./mind` | `./mind ayuda` |

En Mac, macOS puede mostrar un aviso al abrir archivos descargados. Consulta
el mensaje del sistema y confirma el origen de tu descarga antes de abrirlos.

## Conexión técnica (referencia opcional para clientes MCP)

El archivo `.mcp.json` describe la conexión por stdio. En clientes que la
configuran manualmente, usa las rutas absolutas de tu carpeta Mind y deja
`NODE_OPTIONS` vacía.

| Sistema | Programa incluido | Argumentos |
|---|---|---|
| Windows | `Runtime\node\node.exe` | `Motor\bin\mind.js`, `mcp` |
| macOS y Linux | `Runtime/node/bin/node` | `Motor/bin/mind.js`, `mcp` |

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
instalación con `actualizar` y la ruta del paquete de tu equipo.

## Alcance y datos

El acceso a la carpeta abierta dura la sesión; las exclusiones se respetan.
Si el cliente no comunica un proyecto válido, sigue disponible el acceso manual
con `mind autorizar`. Se puede revisar con `mind permisos`.

Mind no proporciona aislamiento del sistema operativo. Las operaciones que un
agente realice por otras herramientas tienen los permisos que le dé su equipo.
La Base contiene rutas, metadatos y continuidad: consérvala como información personal.
Los respaldos cifrados no tienen una auditoría criptográfica externa.

Ayuda: `mind ayuda`. Licencia: `LICENCIA.txt`. Componentes: `LICENCIAS/`.

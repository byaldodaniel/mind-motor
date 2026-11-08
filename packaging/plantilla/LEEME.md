# My Mind

Mind permite a tu agente encontrar, leer, crear, modificar y organizar la
información con la que trabajas. Tus archivos permanecen en su ubicación.
La carpeta `Sistema/Base` conserva los índices y la continuidad de tus trabajos.

## Empezar

1. **Extrae el ZIP de Mind** en una carpeta tuya. El mismo ZIP sirve para
   Windows x64, Mac Intel y Apple Silicon y Linux x64 y ARM64 con glibc.
   Mind trae los ejecutores de Node.js y Python y elige el de tu equipo.
2. **Abre la carpeta My Mind en tu agente una primera vez.** El iniciador prepara su conexión y añade un bloque breve a las instrucciones globales de Codex, Claude Code y Antigravity que detecte en tu perfil. Conserva tus reglas anteriores. El agente puede ejecutarlo por ti; no necesitas editar configuraciones.
3. **Empieza una conversación nueva.** El cliente carga sus instrucciones globales y el agente consulta Mind antes de trabajar. También funciona al abrir otros proyectos, mediante MCP cuando esté conectado o con el iniciador incluido.
4. **Pídele lo que necesites.** Sin otra preferencia, los resultados y lo importante de las conversaciones se guardan en `Conversaciones/`; los datos técnicos están en `Sistema/Base/`. Puedes elegir otro destino general, por tipo, por proyecto o por conversación.

Los chats ya abiertos pueden necesitar una conversación o sesión nueva para cargar instrucciones. Si mueves la carpeta My Mind, vuelve a abrir su iniciador para actualizar la ruta. El arranque no instala un servicio permanente ni modifica los permisos de seguridad del cliente. Las restricciones de tu organización o las instrucciones específicas de un proyecto pueden limitarlo.

En Mac, macOS puede mostrar un aviso al abrir archivos descargados. Consulta
el mensaje del sistema y confirma el origen de tu descarga antes de abrirlos.

## Conexión técnica (referencia opcional para clientes MCP)

Mind genera `.mcp.json` con el programa incluido de tu equipo y la conexión
por stdio. Si tu agente permite configurar MCP manualmente, puedes
consultar ese archivo y resolver sus rutas desde la carpeta My Mind. Los
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
- Crear respaldos cifrados de la Base mediante `Sistema/mind respaldo`.

## Actualizaciones

Mind comprueba las nuevas versiones estables al iniciar. Si hay una para tu equipo,
la descarga, verifica su firma y la instala cuando no haya sesiones activas.
Sin conexión continúa con la versión instalada. Los archivos personales y la Base
se conservan. La recuperación se mantiene solo durante la transacción; después
de comprobar la nueva instalación se eliminan sus temporales. My Mind no acumula versiones anteriores.

Si ya tienes una copia anterior, pídele a tu agente aplicar esta entrega corregida a esa copia conservando tus datos. El agente usa el paquete nuevo verificado y mantiene tu ruta; no necesitas configurar conexiones ni guardar versiones anteriores. Las sesiones que estén trabajando terminan normalmente antes de sustituir el programa.

## Alcance y datos

El acceso a la carpeta abierta dura la sesión; las exclusiones se respetan.
Si el cliente no comunica un proyecto válido, sigue disponible el acceso manual
con `Sistema/mind autorizar`. Se puede revisar con `mind permisos`.

Mind no proporciona aislamiento del sistema operativo. Las operaciones que un
agente realice por otras herramientas tienen los permisos que le dé su equipo.
La Base contiene rutas, metadatos y continuidad: consérvala como información personal.
Los respaldos cifrados no tienen una auditoría criptográfica externa.

Ayuda: `Sistema/mind ayuda`. Licencia: `Sistema/LICENCIA.txt`. Componentes: `Sistema/Licencias/`.

Puedes pedirle al agente trasladar una conversación con sus decisiones y archivos a un proyecto. Mind conserva su identidad y prepara los destinos para continuar. Cuando reúne archivos mediante copias, mantiene los originales como recuperación y el agente indica dónde quedó el trabajo vigente. Mover o renombrar una carpeta mediante Mind también actualiza sus referencias.

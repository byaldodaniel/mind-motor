// Prepara una Base ficticia y una carpeta de ejemplo para medir agentes.
// Uso: node preparar.mjs <raíz-vacía>
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WT = 'C:/Users/Aldo Daniel/Desktop/Mind - Desarrollo/Worktrees/1.0.5-etapa2';
const imp = (p) => import(pathToFileURL(path.join(WT, p)).href);
const { resolveLayout } = await imp('src/layout.js');
const { openSession } = await imp('src/session.js');
const { createAgentTools } = await imp('src/agent-tools.js');

const root = path.resolve(process.argv[2]);
const base = path.join(root, 'Base');
const folder = path.join(root, 'Proyecto Atlas');
await fs.mkdir(base, { recursive: true });
await fs.mkdir(path.join(folder, 'notas'), { recursive: true });

const relleno = (tema, n) => Array.from({ length: n }, (_, i) => `- Registro ${i + 1} sobre ${tema}: dato ficticio sin relevancia para la tarea.`).join('\n');
const frente = `# Frente del Proyecto Atlas

Proyecto ficticio para medir agentes.

## Contexto

${relleno('el contexto', 60)}

## Pendientes

- [ ] Elegir proveedor de cajas #pendiente
- [ ] Revisar presupuesto de transporte #pendiente
- [x] Firmar acuerdo de confidencialidad #pendiente
- [ ] Preparar muestra para el cliente Orión #pendiente

## Decisiones

- 2026-11-10: se aprueba el empaque reciclado.
- 2026-11-14: el envío piloto sale el lunes 24 de noviembre.

## Historial

${relleno('el historial', 120)}
`;
await fs.writeFile(path.join(folder, 'frente.md'), frente);
await fs.writeFile(path.join(folder, 'notas', 'reunion.md'), `# Reunión del 12 de noviembre\n\n- Idea: probar etiquetas de papel #idea\n- [ ] Llamar a logística #pendiente\n`);

const layout = await resolveLayout({ base });
const session = await openSession({ layout, motorVersion: '1.0.4', observe: false });
await session.start();
const scope = await session.motor.authorizeFolder(folder);
await session.policy.set(scope.id, ['encontrar', 'leer', 'escribir', 'organizar'], { channel: 'administracion-local' });
await session.policy.setContinuity(['leer', 'registrar'], { channel: 'administracion-local' });
const tools = createAgentTools({ session, connection: { clientInfo: { name: 'preparacion' }, supportsFormElicitation: () => false } });
const saved = await tools.call('conversacion_guardar', {
  titulo: 'Atlas · lanzamiento del envío piloto',
  importante: 'Decisión: empaque reciclado aprobado el 10-nov. Pendiente: elegir proveedor de cajas antes del viernes 21. Siguiente paso: pedir tres cotizaciones de cajas.',
  proyecto: 'Atlas',
}, {});
await session.close();
console.log(JSON.stringify({ base, folder, conversacion: saved.conversacion.id }));

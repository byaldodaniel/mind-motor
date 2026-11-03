import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { validateCandidateFolder } from './consent.js';
import { ACCESS_LEVELS } from './access-policy.js';

/** El ámbito procede del cliente MCP o del iniciador, nunca de una herramienta. */
export function createWorkspaceAccess(session, { paths = [], cwd = process.cwd(), log = () => {} } = {}) {
  let active = paths.length > 0;
  let grants = new Map();
  const reduced = new Set();
  let ready = Promise.resolve();
  const policy = {
    ...session.policy,
    async get(id) {
      if (!active || reduced.has(id)) return session.policy.get(id);
      const generation = grants.get(id);
      const folder = await session.motor.getAuthorizedFolder(id);
      if (!grants.has(id) || !folder || folder.generation !== generation) return null;
      return { folderId: id, access: Object.fromEntries(ACCESS_LEVELS.map(x => [x, true])), channel: 'carpeta-abierta' };
    },
    async set(id, access, options) {
      reduced.add(id);
      return session.policy.set(id, access, options);
    },
    async getContinuity() {
      return active && grants.size > 0 ? { leer: true, registrar: true, channel: 'carpeta-abierta' } : session.policy.getContinuity();
    },
  };
  const scopedSession = {
    ...session,
    policy,
    motor: {
      ...session.motor,
      async listAuthorizedFolders() {
        const folders = await session.motor.listAuthorizedFolders();
        return active ? folders.filter(f => grants.has(f.id)) : folders;
      },
    },
  };

  async function replace(nextPaths) {
    // Cerrar el ámbito anterior antes de validar o registrar el nuevo.
    grants = new Map();
    for (const candidate of nextPaths) {
      try {
        const canonical = await validateCandidateFolder(candidate, session.layout);
        const registered = await session.motor.authorizeFolder(canonical);
        const folder = await session.motor.getAuthorizedFolder(registered.id);
        grants.set(folder.id, folder.generation);
        await session.audit('carpeta-abierta', { carpeta: folder.id, canal: 'cliente-o-iniciador' });
      } catch (error) {
        log('aviso', 'No se pudo abrir una carpeta del espacio de trabajo', { codigo: error.code ?? 'WORKSPACE_UNAVAILABLE' });
      }
    }
    await session.sync();
  }

  return {
    session: scopedSession,
    async initialize(connection) {
      if (connection.clientCapabilities?.roots && paths.length === 0) {
        active = true;
        await this.refresh(connection);
      } else if (!active) {
        // El directorio de inicio lo fija el cliente/iniciador, no una llamada del modelo.
        try {
          const folder = await validateCandidateFolder(cwd, session.layout);
          active = true;
          ready = replace([folder]);
          await ready;
        } catch { /* La carpeta de Mind o el home no son un proyecto abierto. */ }
      } else if (active) {
        ready = replace(paths);
        await ready;
      }
    },
    async refresh(connection) {
      if (!connection.clientCapabilities?.roots || paths.length > 0) return;
      active = true;
      // No reutilizar el ámbito anterior si el cliente falla o retira sus raíces.
      grants = new Map();
      ready = ready.catch(() => {}).then(async () => {
        try {
          const result = await connection.request('roots/list', {}, { timeoutMs: 5000 });
          if (!Array.isArray(result?.roots) || result.roots.length > 64) throw new Error('Invalid roots');
          const next = result.roots.map(root => {
            const uri = new URL(root.uri);
            if (uri.protocol !== 'file:' || uri.search || uri.hash) throw new Error('Invalid root URI');
            return fileURLToPath(uri);
          });
          await replace(next);
        } catch (error) {
          grants = new Map();
          log('aviso', 'El cliente no pudo comunicar sus carpetas abiertas', { codigo: error.code ?? 'ROOTS_UNAVAILABLE' });
        }
      });
      await ready;
    },
    async beforeCall(name, args) {
      await ready;
      if (active && name === 'solicitar_acceso' && args.continuidad === undefined) {
        const canonical = await validateCandidateFolder(args.ruta, session.layout);
        const folders = await scopedSession.motor.listAuthorizedFolders();
        if (!folders.some(f => f.path === canonical)) {
          throw new MotorError('WORKSPACE_REQUIRED', 'Abre esta carpeta en tu agente para trabajar con ella mediante Mind.');
        }
      }
    },
    active: () => active,
  };
}

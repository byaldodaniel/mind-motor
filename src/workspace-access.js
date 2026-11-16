import { contains, currentDirectory, samePath } from './paths.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MotorError } from './errors.js';
import { validateCandidateFolder } from './consent.js';
import { ACCESS_LEVELS } from './access-policy.js';

const IGNORED_AGENT_DIR_PATTERN = /(?:^|[\\/])\.(?:codex|claude|gemini)(?:$|[\\/])|(?:^|[\\/])Documents[\\/]Codex(?:$|[\\/])/iu;

function isIgnoredWorkspaceCandidate(candidate) {
  return typeof candidate === 'string' && IGNORED_AGENT_DIR_PATTERN.test(candidate);
}

/** El ámbito procede del cliente MCP o del iniciador, nunca de una herramienta. */
export function createWorkspaceAccess(session, { paths = [], cwd = currentDirectory(), log = () => {} } = {}) {
  let active = paths.length > 0;
  let grants = new Map();
  const ephemeralGrants = new Set();
  const reduced = new Set();
  let ready = Promise.resolve();
  const userDataDirectory = session.layout.userDataDirectory;
  async function releaseEphemeral() {
    for (const id of [...ephemeralGrants]) {
      ephemeralGrants.delete(id);
      await session.motor.releaseSessionFolder?.(id).catch(() => {});
    }
  }
  function normalizeCandidate(candidate) {
    if (typeof candidate !== 'string' || !candidate.trim()) return null;
    if (session.layout.root) {
      try {
        if (samePath(candidate, session.layout.root)) return userDataDirectory ?? null;
      } catch {}
    }
    if (isIgnoredWorkspaceCandidate(candidate)) return null;
    return candidate;
  }
  async function isDestination(folder) {
    if(!folder)return false;
    const directories=await session.motor.workDestinationDirectories();
    return directories.some(directory=>contains(folder.path,directory));
  }
  const policy = {
    ...session.policy,
    async get(id) {
      if (reduced.has(id)) return session.policy.get(id);
      const generation = grants.get(id);
      const folder = await session.motor.getAuthorizedFolder(id);
      if(!grants.has(id))return !active || await isDestination(folder) ? session.policy.get(id) : null;
      if(!folder || folder.generation !== generation)return null;
      return { folderId: id, access: Object.fromEntries(ACCESS_LEVELS.map(x => [x, true])), channel: 'carpeta-abierta' };
    },
    async set(id, access, options) {
      reduced.add(id);
      return session.policy.set(id, access, options);
    },
    async getContinuity() {
      return grants.size > 0 ? { leer: true, registrar: true, channel: 'carpeta-abierta' } : session.policy.getContinuity();
    },
  };
  const scopedSession = {
    ...session,
    policy,
    motor: {
      ...session.motor,
      async listAuthorizedFolders() {
        const folders = await session.motor.listAuthorizedFolders();
        if(!active)return folders;
        const allowed=[];
        for(const folder of folders) {
          if(grants.has(folder.id))allowed.push(folder);
          else if(await isDestination(folder) && (await session.policy.get(folder.id))?.access.encontrar)allowed.push(folder);
        }
        return allowed;
      },
    },
  };

  async function replace(nextPaths) {
    // Cerrar el ámbito anterior antes de validar o registrar el nuevo.
    const previousGrants = new Set(grants.keys());
    grants = new Map();
    await releaseEphemeral();
    const mapped = nextPaths.map(normalizeCandidate).filter(Boolean);
    const candidates = [...new Set([...mapped, ...(userDataDirectory ? [userDataDirectory] : [])])];
    for (const candidate of candidates) {
      try {
        const canonical = await validateCandidateFolder(candidate, session.layout);
        const isPersistentUserDir = Boolean(userDataDirectory && samePath(canonical, userDataDirectory));
        const registered = isPersistentUserDir || typeof session.motor.authorizeSessionFolder !== 'function'
          ? await session.motor.authorizeFolder(canonical)
          : await session.motor.authorizeSessionFolder(canonical);
        if (registered?.ephemeral) ephemeralGrants.add(registered.id);
        const folder = await session.motor.getAuthorizedFolder(registered.id);
        if (!folder) continue;
        grants.set(folder.id, folder.generation);
        if (!previousGrants.has(folder.id)) {
          await session.audit('carpeta-abierta', { carpeta: folder.id, canal: 'cliente-o-iniciador' });
        }
      } catch (error) {
        log('aviso', 'No se pudo abrir una carpeta del espacio de trabajo', { codigo: error.code ?? 'WORKSPACE_UNAVAILABLE' });
      }
    }
    await session.sync();
  }

  return {
    session: scopedSession,
    async initialize(connection) {
      if(connection.clientCapabilities?.roots && paths.length===0) {
        active=true;await this.refresh(connection);
      } else {
        let candidates = paths.map(normalizeCandidate).filter(Boolean);
        if (candidates.length === 0) {
          const normalizedCwd = normalizeCandidate(cwd);
          if (normalizedCwd) {
            try { candidates = [await validateCandidateFolder(normalizedCwd, session.layout)]; } catch {}
          }
        }
        if (candidates.length > 0 || userDataDirectory) {
          active = candidates.length > 0;
          ready = replace(candidates);
          await ready;
        }
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
        const configured=await session.motor.workDestinationDirectories();
        if (!folders.some(f => f.path === canonical) && !configured.some(directory=>contains(canonical,directory))) {
          throw new MotorError('WORKSPACE_REQUIRED', 'Abre esta carpeta en tu agente para trabajar con ella mediante Mind.');
        }
      }
    },
    async close() {
      await ready.catch(() => {});
      grants = new Map();
      await releaseEphemeral();
    },
    active: () => active,
  };
}

import { productPaths } from './layout.js';
import { lockInstallation } from './installation-lock.js';
import { recoverAbandonedOwnerFile } from './process-identity.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { MotorError } from './errors.js';
import { samePath } from './paths.js';
import { ACCESS_LEVELS, CONTINUITY_LEVELS, ACCESS_PRESETS, PRESET_LABELS, minimumPreset, normalizeAccess, describeAccess } from './access-policy.js';
import { CONTINUITY_ACCESS_LABELS, validateCandidateFolder, untrustedText } from './consent.js';
import { liveSessions } from './session.js';
import { reviewAutomationRequest } from './automations/service.js';
import { reviewOperationRequest } from './organize-service.js';

/**
 * Consola de Mind para el usuario: aprobar solicitudes, autorizar carpetas,
 * revisar y retirar permisos, y reparar la Base. Exige un terminal interactivo:
 * es el canal de consentimiento para clientes que no muestran formularios.
 *
 * Límite: un programa con los permisos del usuario puede simular un terminal.
 * Este canal evita autorizaciones accidentales o inducidas a través de Mind,
 * pero no aísla frente a un agente con acceso libre al sistema.
 */

export function requireInteractive(stdin = process.stdin, stdout = process.stdout) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new MotorError('CONSOLE_REQUIRED', 'Esta orden la ejecuta el usuario en un terminal interactivo (por ejemplo, con doble clic en "Autorizar Mind").');
  }
}

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  // Salida silenciable: las frases y los códigos de recuperación se escriben sin eco.
  const muted = new Writable({
    write(chunk, encoding, callback) {
      if (!muted.silent) output.write(chunk, encoding);
      callback();
    },
  });
  muted.isTTY = output.isTTY;
  muted.columns = output.columns;
  const rl = readline.createInterface({ input, output: muted, terminal: Boolean(output.isTTY) });
  return {
    write: (line = '') => output.write(`${line}\n`),
    async ask(question) {
      return (await rl.question(question)).trim();
    },
    /** Pregunta sin mostrar lo que se escribe (frases, códigos). No recorta espacios. */
    async secret(question) {
      output.write(question);
      muted.silent = true;
      try {
        return await rl.question('');
      } finally {
        muted.silent = false;
        output.write('\n');
      }
    },
    async yes(question, fallback = false) {
      const answer = (await rl.question(`${question} ${fallback ? '[S/n]' : '[s/N]'} `)).trim().toLowerCase();
      if (answer === '') return fallback;
      return ['s', 'si', 'sí', 'y', 'yes'].includes(answer);
    },
    close: () => rl.close(),
  };
}

/** Una sola elección (opción 1). Devuelve los permisos o null si el usuario no autoriza. */
async function choosePreset(prompt, requested) {
  const presets = Object.keys(ACCESS_PRESETS);
  const suggested = minimumPreset(normalizeAccess(requested));
  prompt.write(`Solicitado: ${PRESET_LABELS[suggested]}`);
  presets.forEach((name, position) => prompt.write(`  ${position + 1}) ${PRESET_LABELS[name]}`));
  prompt.write('  0) No autorizar');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = await prompt.ask('Elige una opción [0-3]: ');
    if (answer === '0' || answer === '') return null;
    const chosen = presets[Number(answer) - 1];
    if (chosen) return normalizeAccess(ACCESS_PRESETS[chosen]);
    prompt.write('Opción no válida.');
  }
  return null;
}

/** Pregunta opcional de exclusiones al autorizar una carpeta. */
async function askExclusions(prompt) {
  const answer = await prompt.ask('Subcarpetas a excluir, separadas por comas (Enter para ninguna): ');
  return (answer ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

/** Aprueba o rechaza las solicitudes pendientes y, opcionalmente, autoriza una carpeta indicada. */
export async function authorizeConsole({ session, prompt, folderPath = null, requested = null }) {
  const { motor, policy, requests } = session;
  let changes = 0;
  if (folderPath !== null) {
    const canonical = await validateCandidateFolder(folderPath, {
      protectedDirectories: session.layout?.protectedDirectories,
      baseDirectory: motor.baseDirectory,
      motorDirectory: session.layout?.motorDirectory,
      userDataDirectory: session.layout?.userDataDirectory,
    });
    prompt.write(`Carpeta (incluye todo lo que contiene): ${canonical}`);
    const access = await choosePreset(prompt, requested ?? ['leer']);
    if (access) {
      const exclusions = await askExclusions(prompt);
      const folder = await motor.authorizeFolder(canonical);
      if (exclusions.length > 0) await motor.setFolderExclusions(folder.id, exclusions);
      await policy.set(folder.id, access, { channel: 'consola' });
      await session.audit('carpeta-autorizada', { carpeta: folder.id, ruta: folder.path, permisos: describeAccess(access), canal: 'consola' });
      prompt.write(`Autorizada con permisos: ${describeAccess(access).join(', ')}.`);
      changes += 1;
    }
  }
  const pending = await requests.list();
  if (pending.length === 0 && folderPath === null) prompt.write('No hay solicitudes pendientes.');
  for (const request of pending) {
    prompt.write('');
    prompt.write(`Solicitud de ${untrustedText(request.client, 120) || 'un agente'} (${request.createdAt})`);
    if (request.reason) prompt.write(`Motivo indicado por el agente (no verificado): «${untrustedText(request.reason)}»`);
    if (request.kind === 'carpeta') {
      prompt.write(`Carpeta (incluye todo lo que contiene): ${request.path}`);
      let canonical;
      try {
        canonical = await validateCandidateFolder(request.path, {
          protectedDirectories: session.layout?.protectedDirectories,
          baseDirectory: motor.baseDirectory,
          motorDirectory: session.layout?.motorDirectory,
          userDataDirectory: session.layout?.userDataDirectory,
        });
      } catch (error) {
        prompt.write(`No se puede autorizar: ${error.message}`);
        await requests.remove(request.id);
        continue;
      }
      const access = await choosePreset(prompt, request.requested);
      if (access) {
        const exclusions = await askExclusions(prompt);
        const folder = await motor.authorizeFolder(canonical);
        if (exclusions.length > 0) {
          const current = (await motor.getAuthorizedFolder(folder.id))?.exclusions ?? [];
          await motor.setFolderExclusions(folder.id, [...current, ...exclusions]);
        }
        const previous = (await policy.get(folder.id))?.access ?? {};
        for (const level of ACCESS_LEVELS) access[level] ||= previous[level] === true;
        await policy.set(folder.id, access, { channel: 'consola' });
        await session.audit('carpeta-autorizada', { carpeta: folder.id, ruta: folder.path, permisos: describeAccess(access), canal: 'consola', cliente: request.client });
        prompt.write(`Autorizada con permisos: ${describeAccess(access).join(', ')}.`);
        changes += 1;
      } else {
        prompt.write('Rechazada.');
      }
    } else if (request.kind === 'borrado' || request.kind === 'vaciado') {
      // Borrado o vaciado pedido por un agente: Mind lo describe y lo ejecuta si el usuario confirma.
      const outcome = await reviewOperationRequest({ session, prompt, request });
      if (outcome.done) changes += 1;
    } else if (request.kind === 'automatizacion') {
      // Activación automática de una función: se revisa la versión exacta solicitada.
      const outcome = await reviewAutomationRequest({ session, prompt, request });
      if (outcome.approved) changes += 1;
      if (outcome.keep) continue;
    } else {
      prompt.write(`Continuidad: ${request.requested.join(', ')}`);
      if (await prompt.yes('¿Autorizar?', false)) {
        const current = await policy.getContinuity();
        const access = { leer: current.leer, registrar: current.registrar };
        let grantedAny = false;
        for (const level of CONTINUITY_LEVELS.filter((item) => request.requested.includes(item))) {
          if (await prompt.yes(`  ¿Permitir: ${CONTINUITY_ACCESS_LABELS[level].toLowerCase()}?`, false)) {
            access[level] = true;
            grantedAny = true;
          }
        }
        if (grantedAny) {
          await policy.setContinuity(describeAccess(access, CONTINUITY_LEVELS), { channel: 'consola' });
          await session.audit('continuidad-autorizada', { permisos: describeAccess(access, CONTINUITY_LEVELS), canal: 'consola', cliente: request.client });
          prompt.write(`Continuidad: ${describeAccess(access, CONTINUITY_LEVELS).join(', ') || 'sin permisos'}.`);
          changes += 1;
        } else {
          prompt.write('Rechazada.');
        }
      } else {
        prompt.write('Rechazada.');
      }
    }
    await requests.remove(request.id);
  }
  return changes;
}

function matchFolder(item, reference) {
  if (!reference) return false;
  if (item.id === reference) return true;
  return path.isAbsolute(reference)
    ? samePath(item.path, path.resolve(reference))
    : item.path === path.normalize(reference);
}

/** Lista y retira permisos. */
export async function permissionsConsole({ session, prompt, revoke = null, revokePermissions = null, exclude = null, include = null, target = null }) {
  const { motor, policy } = session;
  const folders = await motor.listAuthorizedFolders();
  if (exclude !== null || include !== null) {
    const folder = folders.find((item) => matchFolder(item, target));
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'Esa carpeta no está autorizada.');
    const current = (await motor.getAuthorizedFolder(folder.id))?.exclusions ?? [];
    let next = current;
    if (exclude !== null) next = [...current, ...exclude];
    if (include !== null) {
      // Volver a incluir amplía el acceso de los agentes: lo confirma el usuario.
      if (!(await prompt.yes(`¿Volver a incluir ${include.join(', ')} en ${folder.path}?`, false))) return 0;
      const removed = new Set(include.map((item) => item.replace(/^\/+|\/+$/g, '')));
      next = current.filter((item) => !removed.has(item));
    }
    const result = await motor.setFolderExclusions(folder.id, next);
    await session.audit(include !== null ? 'rutas-incluidas' : 'rutas-excluidas', { carpeta: folder.id, excluidas: result.exclusions, canal: 'consola' });
    if (include !== null) await session.ensureIndex(folder.id).catch(() => {});
    prompt.write(`Excluidas en ${folder.path}: ${result.exclusions.join(', ') || 'ninguna'}.`);
    return 1;
  }
  if (revoke !== null) {
    if (revoke === 'continuidad' || revoke === '--continuidad') {
      const cleaned = (revokePermissions ?? []).map((item) => String(item).replace(/^--/, ''));
      const requested = cleaned.length > 0 ? normalizeAccess(cleaned, CONTINUITY_LEVELS) : { leer: true, registrar: true };
      if (requested.leer) requested.registrar = true;
      const removing = describeAccess(requested, CONTINUITY_LEVELS);
      if (!(await prompt.yes('¿Retirar permisos de continuidad?', false))) return 0;
      const current = await policy.getContinuity();
      const retained = CONTINUITY_LEVELS.filter((level) => current[level] === true && !removing.includes(level));
      await policy.setContinuity(retained, { channel: 'consola' });
      await session.audit('continuidad-retirada', { permisos: retained, canal: 'consola' });
      prompt.write(`Continuidad: ${retained.join(', ') || 'sin permisos'}`);
      return 1;
    }
    const folder = folders.find((item) => matchFolder(item, revoke));
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'Esa carpeta no está autorizada.');
    if (Array.isArray(revokePermissions) && revokePermissions.length > 0) {
      const cleaned = revokePermissions.map((item) => String(item).replace(/^--/, ''));
      const removing = describeAccess(normalizeAccess(cleaned, ACCESS_LEVELS), ACCESS_LEVELS);
      if (!removing.includes('encontrar')) {
        if (!(await prompt.yes(`¿Retirar ${removing.join(', ')} en ${folder.path}?`, false))) return 0;
        const decision = await policy.get(folder.id);
        const access = { ...(decision?.access ?? normalizeAccess([])) };
        for (const level of removing) access[level] = false;
        const saved = await policy.set(folder.id, access, { channel: 'consola' });
        await session.audit('permisos-reducidos', { carpeta: folder.id, permisos: describeAccess(saved.access), canal: 'consola' });
        prompt.write(`Permisos en ${folder.path}: ${describeAccess(saved.access).join(', ') || 'ninguno para agentes'}.`);
        return 1;
      }
    }
    if (!(await prompt.yes(`¿Retirar ${folder.path} de Mind? Se elimina su índice; los originales no se tocan.`, false))) return 0;
    await motor.revokeFolder(folder.id);
    await policy.remove(folder.id);
    await session.audit('carpeta-retirada', { carpeta: folder.id, ruta: folder.path, canal: 'consola' });
    prompt.write('Retirada.');
    return 1;
  }
  if (folders.length === 0) prompt.write('No hay carpetas autorizadas.');
  for (const folder of folders) {
    const decision = await policy.get(folder.id);
    prompt.write(`${folder.path}`);
    prompt.write(`  id: ${folder.id}`);
    prompt.write(`  permisos: ${decision ? describeAccess(decision.access).join(', ') : 'ninguno para agentes'}`);
    const exclusions = (await motor.getAuthorizedFolder(folder.id))?.exclusions ?? [];
    if (exclusions.length > 0) prompt.write(`  excluidas: ${exclusions.join(', ')}`);
  }
  const continuity = await policy.getContinuity();
  prompt.write(`Continuidad: ${describeAccess(continuity, CONTINUITY_LEVELS).join(', ') || 'sin permisos'}`);
  return 0;
}

/**
 * Recuperación guiada de la Base tras un cierre abrupto. Sigue el procedimiento
 * documentado en docs/CONCURRENCIA_INDICES.md: solo actúa si ninguna sesión de
 * Mind sigue viva y el usuario confirma que cerró todos sus agentes.
 */
export async function repairConsole({ session, prompt }) {
  const base = session.motor.baseDirectory;
  const options = { pythonExecutable: session.layout.pythonExecutable };
  const release = session.layout.product ? await lockInstallation(session.layout.root, options) : async () => {};
  try {
    const locations = [...new Set([base, ...(session.layout.product ? [session.layout.installationStateDirectory ?? productPaths(session.layout.root, session.layout.manifest).installationStateDirectory, path.join(session.layout.root, '.mind-producto')] : [])])];
    const registries = await Promise.all(locations.map(location => liveSessions(location, options)));
    const others = registries.flatMap(registry => registry.live).filter(item => item.id !== session.id);
    const unknown = others.filter(item => item.state === 'unknown');
    if (others.length) {
      prompt.write(unknown.length
        ? 'Hay propietarios no verificables; se conservan sus registros. Revisa permisos o el equipo de origen antes de reparar.'
        : 'Hay sesiones reales de Mind activas. Cierra sus conexiones y vuelve a intentarlo.');
      return 0;
    }
    const entries = await fs.readdir(base);
    // Todos los bloqueos de withIndexLock: índices, trabajo global, prioridad, propiedades e índices personalizados.
    const locks = entries.filter(entry => /^[a-z][a-z0-9-]{0,40}-[a-z0-9][a-z0-9_-]{0,63}\.lock$/.test(entry));
    const temporaries = entries.filter(entry => /^\.mind-[A-Za-z0-9-]+\.tmp$/.test(entry));
    const stale = registries.flatMap(registry => registry.stale.map(item => ({ ...item, directory: registry.directory })));
    if (!locks.length && !stale.length) {
      prompt.write(temporaries.length ? 'Se conservan los temporales sin propietario verificable.' : 'No hay registros abandonados demostrados.');
      return 0;
    }
    prompt.write('Bloqueos de índice: ' + locks.length + '; temporales sin propietario verificable (se conservan): ' + temporaries.length
      + '; registros de sesiones abandonadas: ' + stale.length + '.');
    if (!(await prompt.yes('¿Confirmas que cerraste todos los agentes y programas que usan esta Base?', false))) return 0;
    // Only proven abandoned lock/session owners are removed. Corrupt or active
    // coordination remains intact even after a general confirmation.
    let removed = 0;
    for (const file of locks) {
      if (await recoverAbandonedOwnerFile(path.join(base, file), options)) removed++;
    }
    for (const item of stale) {
      if (await recoverAbandonedOwnerFile(path.join(item.directory, item.file), options)) removed++;
    }
    // A temporary filename does not establish ownership or completed work.
    await session.audit('base-reparada', { retirados: removed, canal: 'consola' });
    prompt.write('Recuperación terminada. Los registros no verificables se conservan.');
    return removed;
  } finally { await release(); }
}

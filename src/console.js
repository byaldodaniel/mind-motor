import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { MotorError } from './errors.js';
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
  const rl = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) });
  return {
    write: (line = '') => output.write(`${line}\n`),
    async ask(question) {
      return (await rl.question(question)).trim();
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
      protectedDirectories: session.layout.protectedDirectories,
      baseDirectory: motor.baseDirectory,
      motorDirectory: session.layout.motorDirectory,
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
          protectedDirectories: session.layout.protectedDirectories,
          baseDirectory: motor.baseDirectory,
          motorDirectory: session.layout.motorDirectory,
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
        for (const level of CONTINUITY_LEVELS.filter((item) => request.requested.includes(item))) {
          access[level] = await prompt.yes(`  ¿Permitir: ${CONTINUITY_ACCESS_LABELS[level].toLowerCase()}?`, false) || access[level];
        }
        await policy.setContinuity(describeAccess(access, CONTINUITY_LEVELS), { channel: 'consola' });
        await session.audit('continuidad-autorizada', { permisos: describeAccess(access, CONTINUITY_LEVELS), canal: 'consola', cliente: request.client });
        prompt.write(`Continuidad: ${describeAccess(access, CONTINUITY_LEVELS).join(', ') || 'sin permisos'}.`);
        changes += 1;
      } else {
        prompt.write('Rechazada.');
      }
    }
    await requests.remove(request.id);
  }
  return changes;
}

/** Lista y retira permisos. */
export async function permissionsConsole({ session, prompt, revoke = null, exclude = null, include = null, target = null }) {
  const { motor, policy } = session;
  const folders = await motor.listAuthorizedFolders();
  if (exclude !== null || include !== null) {
    const folder = folders.find((item) => item.id === target || item.path === path.normalize(target ?? ''));
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
    const folder = folders.find((item) => item.id === revoke || item.path === path.normalize(revoke));
    if (!folder) throw new MotorError('FOLDER_NOT_AUTHORIZED', 'Esa carpeta no está autorizada.');
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
  const { live, stale } = await liveSessions(base);
  const others = live.filter((item) => item.id !== session.id);
  if (others.length > 0) {
    prompt.write(`Hay ${others.length} sesión(es) de Mind activas (agentes abiertos). Ciérralas y vuelve a intentarlo.`);
    return 0;
  }
  const entries = await fs.readdir(base);
  const locks = entries.filter((entry) => /^folder-index-[a-f0-9]{64}\.lock$/.test(entry));
  const temporaries = entries.filter((entry) => /^\.mind-[A-Za-z0-9-]+\.tmp$/.test(entry));
  if (locks.length + temporaries.length + stale.length === 0) {
    prompt.write('La Base no tiene bloqueos ni temporales abandonados.');
    return 0;
  }
  prompt.write(`Bloqueos de índice: ${locks.length}; temporales: ${temporaries.length}; sesiones cerradas sin limpiar: ${stale.length}.`);
  if (!(await prompt.yes('¿Confirmas que cerraste todos los agentes y programas que usan esta Base?', false))) return 0;
  for (const entry of [...locks, ...temporaries]) await fs.rm(path.join(base, entry), { force: true });
  for (const item of stale) await fs.rm(path.join(base, 'sesiones', item.file), { force: true });
  await session.audit('base-reparada', { bloqueos: locks.length, temporales: temporaries.length, sesiones: stale.length, canal: 'consola' });
  prompt.write('Listo. Los índices afectados se reconcilian en la próxima sesión.');
  return locks.length + temporaries.length + stale.length;
}

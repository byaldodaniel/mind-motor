import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { MotorError } from './errors.js';
import { acquireOwnerFileLock } from './process-identity.js';
import { readJson, writeJson } from './storage.js';
import { releaseOf, compareReleases } from './package-descriptor.js';
import { getVerifiedOffer } from './auto-update.js';
import { ensureUpdateDirectory, updateStatePaths } from './update-state.js';

const TTL_MS = 15 * 60_000;
const HASH = /^[a-f0-9]{64}$/u;
const CODE = /^[a-f0-9]{24}$/u;
const digest = value => createHash('sha256').update(value).digest('hex');

export function updateConsentPaths(root) {
  const { directory } = updateStatePaths(root);
  return { file: path.join(directory, 'consentimiento.json'), lock: path.join(directory, 'consentimiento.lock') };
}

function identityOf(offer) {
  if (!offer?.feed || !offer?.selected || !offer?.current || compareReleases(offer.feed, offer.current) <= 0) {
    throw new MotorError('UPDATE_NOT_AVAILABLE', 'No hay una entrega nueva verificada para aplicar.');
  }
  const identity = { release: releaseOf(offer.feed), manifestSha256: offer.feed.manifestSha256, packageSha256: offer.selected.sha256 };
  if (!HASH.test(identity.manifestSha256) || !HASH.test(identity.packageSha256)) {
    throw new MotorError('UPDATE_SIGNATURE_INVALID', 'La entrega verificada no identifica el manifiesto y el paquete exactos.');
  }
  return identity;
}
const sameIdentity = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function withConsent(layout, acquireLock, body) {
  await ensureUpdateDirectory(layout.root, true);
  const paths = updateConsentPaths(layout.root);
  const unlock = await acquireLock(paths.lock, { pythonExecutable: layout.pythonExecutable, timeoutMs: 5_000 });
  try { return await body(paths); }
  finally { await unlock(); }
}

async function readConsent(file) {
  const stored = await readJson(file);
  if (!stored) return null;
  const value = stored.data;
  if (value?.format !== 'mind-update-consent' || value.version !== 1
      || !HASH.test(value.codeHash) || !value.identity || !Number.isFinite(Date.parse(value.expiresAt))
      || !['pendiente', 'consumido', 'cancelado', 'caducado'].includes(value.status)) {
    throw new MotorError('UPDATE_CONSENT_INVALID', 'El consentimiento guardado no es verificable; solicita una nueva confirmación.');
  }
  return value;
}

async function defaultRequestUpdate(options) {
  const { requestUpdate } = await import('./update-handoff.js');
  return requestUpdate(options);
}

async function submit(layout, identity, requestUpdate) {
  return requestUpdate({ layout, expectedRelease: identity.release,
    expectedManifestSha256: identity.manifestSha256, expectedPackageSha256: identity.packageSha256 });
}

/**
 * Solo se llama tras la petición expresa de aplicar. El formulario pertenece al
 * cliente. Si no existe, se devuelve un código para una segunda confirmación del
 * usuario; nunca se descarga durante el primer paso. El código vence y solo
 * autoriza el manifiesto y paquete firmados que se mostraron.
 */
export async function applyUpdateConsent({
  layout, consent = null, codigo, now = Date.now, getOffer = getVerifiedOffer,
  requestUpdate = defaultRequestUpdate, acquireLock = acquireOwnerFileLock,
} = {}) {
  if (!layout?.product || !layout.root) {
    throw new MotorError('UPDATE_NOT_INSTALLATION', 'Esta copia es de desarrollo; no recibe actualizaciones.');
  }
  if (codigo !== undefined && (typeof codigo !== 'string' || !CODE.test(codigo.trim().toLowerCase()))) {
    throw new MotorError('INVALID_ARGUMENTS', 'codigo debe ser el código de confirmación que devolvió Mind.');
  }
  const offered = await getOffer({ root: layout.root });
  const identity = identityOf(offered);

  if (codigo !== undefined) {
    return withConsent(layout, acquireLock, async paths => {
      const stored = await readConsent(paths.file);
      if (!stored || stored.status !== 'pendiente') {
        throw new MotorError('UPDATE_CONSENT_REQUIRED', 'La confirmación ya se utilizó o no existe. Solicita una nueva.');
      }
      if (Date.parse(stored.expiresAt) <= now()) {
        await writeJson(paths.file, { ...stored, status: 'caducado' });
        throw new MotorError('UPDATE_CONSENT_EXPIRED', 'El código caducó; solicita una nueva confirmación.');
      }
      // El estado y el canal pueden cambiar mientras se espera el bloqueo.
      const currentIdentity = identityOf(await getOffer({ root: layout.root }));
      if (!sameIdentity(stored.identity, identity) || !sameIdentity(stored.identity, currentIdentity)) {
        await writeJson(paths.file, { ...stored, status: 'cancelado' });
        throw new MotorError('UPDATE_CANDIDATE_CHANGED', 'La entrega cambió desde la confirmación. Consulta los cambios y vuelve a pedir autorización.');
      }
      const suppliedHash = digest(codigo.trim().toLowerCase());
      if (!timingSafeEqual(Buffer.from(stored.codeHash, 'hex'), Buffer.from(suppliedHash, 'hex'))) {
        throw new MotorError('UPDATE_CONSENT_INVALID', 'El código no coincide con la confirmación pendiente.');
      }
      // Durable antes de lanzar: un corte no convierte el código en reutilizable.
      await writeJson(paths.file, { ...stored, status: 'consumido', consumedAt: new Date(now()).toISOString() });
      return submit(layout, currentIdentity, requestUpdate);
    });
  }

  const answer = consent?.confirm
    ? await consent.confirm({ title: 'Aplicar esta actualización de Mind',
      message: 'Aplicar Mind ' + identity.release.mindVersion + ' (revisión ' + identity.release.packageRevision
        + '). Mind descargará y preparará el paquete mientras sigue funcionando; esperará a que no haya trabajo ni formularios pendientes antes de cambiar el programa. Se conservarán la Base, las conversaciones y los destinos. Autoriza solo si pediste aplicar esta versión.' })
    : { status: 'unavailable' };
  if (answer.status === 'approved') {
    const checked = identityOf(await getOffer({ root: layout.root }));
    if (!sameIdentity(identity, checked)) {
      throw new MotorError('UPDATE_CANDIDATE_CHANGED', 'La entrega cambió mientras se mostraba el formulario. Vuelve a pedir autorización.');
    }
    return withConsent(layout, acquireLock, async paths => {
      const finalIdentity = identityOf(await getOffer({ root: layout.root }));
      if (!sameIdentity(identity, finalIdentity)) throw new MotorError('UPDATE_CANDIDATE_CHANGED', 'La entrega cambió antes de aplicar; vuelve a pedir autorización.');
      const stored = await readConsent(paths.file);
      if (stored?.status === 'pendiente') await writeJson(paths.file, { ...stored, status: 'cancelado' });
      return submit(layout, finalIdentity, requestUpdate);
    });
  }
  if (answer.status !== 'unavailable') {
    await withConsent(layout, acquireLock, async paths => {
      const stored = await readConsent(paths.file);
      if (stored?.status === 'pendiente') await writeJson(paths.file, { ...stored, status: 'cancelado' });
    });
    return { estado: 'cancelada', indicacion: 'El usuario no confirmó la actualización. No se ha descargado ni instalado.' };
  }

  return withConsent(layout, acquireLock, async paths => {
    const checked = identityOf(await getOffer({ root: layout.root }));
    if (!sameIdentity(identity, checked)) throw new MotorError('UPDATE_CANDIDATE_CHANGED', 'La entrega cambió; vuelve a pedir confirmación.');
    const code = randomBytes(12).toString('hex');
    const expiresAt = new Date(now() + TTL_MS).toISOString();
    await writeJson(paths.file, { format: 'mind-update-consent', version: 1, status: 'pendiente',
      identity, codeHash: digest(code), createdAt: new Date(now()).toISOString(), expiresAt });
    return { estado: 'requiere-confirmacion', version: identity.release.mindVersion, revision: identity.release.packageRevision,
      codigo: code, caduca: expiresAt,
      indicacion: 'Este cliente no admite formularios. Pregunta al usuario si confirma aplicar esta versión de Mind. Espera su respuesta; solo si confirma expresamente llama de nuevo a actualizacion_aplicar con este codigo. El código es de un solo uso y caduca en quince minutos.' };
  });
}

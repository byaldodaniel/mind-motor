import fs from 'node:fs/promises';
import path from 'node:path';
import { getVerifiedOffer, discoverUpdate } from '../src/auto-update.js';
import { resolveLayout } from '../src/layout.js';
import { releaseOf } from '../src/package-descriptor.js';
import { describeUpdate, postponeUpdate, takeNotice } from '../src/update-assistant.js';
import { takeUpdateReport } from '../src/update-handoff.js';
import { applyUpdateConsent } from '../src/update-consent.js';

const fault = (code, message) => Object.assign(new Error(message), { code });
const identityOf = ({ feed, selected }) => ({
  release: releaseOf(feed), manifestSha256: feed.manifestSha256, packageSha256: selected.sha256,
});

async function run({ op, args, identity, approved, report, notice, connection }) {
  const [base, root] = process.argv.slice(2);
  if (!path.isAbsolute(base) || !path.isAbsolute(root)) {
    throw fault('UPDATE_NOT_INSTALLATION', 'La instalación del Motor no es válida.');
  }
  const layout = await resolveLayout({ base });
  if (!layout.product || await fs.realpath(root) !== await fs.realpath(layout.root)) {
    throw fault('UPDATE_NOT_INSTALLATION', 'La instalación no coincide con la del Motor.');
  }
  const getOffer = () => getVerifiedOffer({ root: layout.root });
  switch (op) {
    case 'avisos': {
      const options = { layout, conexion: connection ?? null };
      const result = {};
      const acta = report ? await takeUpdateReport(options) : null;
      if (acta) result.acta_actualizacion = acta;
      const aviso = notice ? await takeNotice({ ...options, getOffer }) : null;
      if (aviso) result.aviso_actualizacion = aviso;
      return result;
    }
    case 'descubrir':
      return discoverUpdate({ root: layout.root });
    case 'actualizacion_consultar':
      return describeUpdate({ layout, getOffer });
    case 'actualizacion_posponer':
      return postponeUpdate({ layout, dias: args.dias, getOffer });
    case 'actualizacion_aplicar':
      return applyUpdateConsent({ layout, codigo: args.codigo });
    case 'preparar':
      return identityOf(await getOffer());
    case 'confirmar':
      return applyUpdateConsent({
        layout,
        getOffer: async () => {
          const offer = await getOffer();
          if (JSON.stringify(identityOf(offer)) !== JSON.stringify({
            release: releaseOf(identity.release), manifestSha256: identity.manifestSha256,
            packageSha256: identity.packageSha256,
          })) {
            throw fault('UPDATE_CANDIDATE_CHANGED', 'La entrega cambió durante la confirmación. Vuelve a consultar y pedir autorización.');
          }
          return offer;
        },
        consent: { confirm: async () => ({ status: approved === true ? 'approved' : 'declined' }) },
      });
    default:
      throw fault('INVALID_ARGUMENTS', 'Operación de actualización no válida.');
  }
}

let response;
try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const text of process.stdin) {
    input += text;
    if (input.length > 8192) throw fault('INVALID_ARGUMENTS', 'Petición de actualización demasiado larga.');
  }
  response = { ok: true, value: await run(JSON.parse(input)) };
} catch (error) {
  response = { ok: false, code: error.code ?? 'UPDATE_UNAVAILABLE', message: error.message };
}
process.stdout.write(JSON.stringify(response) + '\n');

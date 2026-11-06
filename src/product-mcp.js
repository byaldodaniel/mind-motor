import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MotorError } from './errors.js';
import { productInstallation, productRuntime } from './layout.js';
import { readJson, writeJson } from './storage.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const portable = (value) => value.replaceAll('\\', '/');

function generatedConfig(root, runtime) {
  return {
    type: 'stdio',
    command: portable(path.relative(root, runtime.nodeExecutable)),
    args: ['Motor/bin/mind.js', 'mcp'],
    env: { NODE_OPTIONS: '' },
  };
}

function normalize(entry) {
  if (!isObject(entry) || typeof entry.command !== 'string' || !Array.isArray(entry.args)
      || entry.args.some((value) => typeof value !== 'string')) return entry;
  return { ...entry, command: portable(entry.command), args: entry.args.map(portable) };
}

/** Escribe solo la entrada de Mind, relativa al producto y para su destino activo. */
export async function prepareProductMcp() {
  const { root, manifest } = await productInstallation();
  if (!Array.isArray(manifest?.targets)) return 'no-aplica';
  const config = generatedConfig(root, productRuntime(root, manifest));
  const file = path.join(root, '.mcp.json');
  const stored = await readJson(file);
  const data = stored ? stored.data : {};
  if (!isObject(data) || (data.mcpServers !== undefined && !isObject(data.mcpServers))) {
    throw new MotorError('MCP_CONFIG_INVALID', 'La configuración .mcp.json de esta carpeta no tiene el formato esperado.');
  }

  const servers = data.mcpServers ?? {};
  if (Object.hasOwn(servers, 'mind')) {
    const existing = normalize(servers.mind);
    if (isDeepStrictEqual(existing, config)) return 'vigente';
    const generated = manifest.targets.some((target) => {
      const [platform, arch] = target.split('-');
      return isDeepStrictEqual(existing, generatedConfig(root, productRuntime(root, manifest, platform, arch)));
    });
    const legacyPosix = generatedConfig(root, productRuntime(root, null, 'darwin'));
    if (!generated && !isDeepStrictEqual(existing, legacyPosix)) return 'personalizada';
  }

  await writeJson(file, { ...data, mcpServers: { ...servers, mind: config } });
  return 'preparada';
}

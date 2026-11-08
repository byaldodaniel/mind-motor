import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateManifest, verifyTree, describeProblems } from './product-files.js';
import { productRuntime } from './layout.js';

/**
 * Cuarentena de macOS (decisión del usuario, opción B).
 *
 * Al descargar Mind con un navegador, macOS marca los archivos extraídos con
 * el atributo com.apple.quarantine y Gatekeeper puede impedir que se ejecute
 * el intérprete de Python incluido, que no está firmado ni notarizado. La
 * primera vez que el usuario acepta ejecutar Mind en su agente (o abre una
 * orden de consola), y antes del primer uso de Python, Mind:
 *
 * 1. comprueba si algún archivo del runtime activo conserva el atributo;
 * 2. verifica el SHA-256 de los archivos del runtime activo (y sus enlaces)
 *    contra mind-producto.json, sin admitir archivos que no figuren en él;
 * 3. solo si todo coincide, ejecuta /usr/bin/xattr -dr com.apple.quarantine
 *    en la subcarpeta del destino activo dentro de su propia carpeta Runtime.
 *
 * Si algo no coincide no retira nada e informa. Fuera de macOS o en
 * desarrollo (sin manifiesto) no hace nada.
 */

export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine';

function runProgram(command, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error?.message ?? error) });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < 65_536) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** ¿Queda algún archivo de Runtime/ en cuarentena? */
async function quarantined(runtime, { root, platformFiles, find, xattr, run }) {
  // find de macOS admite -xattrname; si fallara, se consultan los intérpretes.
  const listed = await run(find, [runtime, '-xattrname', QUARANTINE_ATTRIBUTE, '-print']);
  if (listed.code === 0) return listed.stdout.trim() !== '';
  for (const relative of platformFiles) {
    const probe = await run(xattr, ['-p', QUARANTINE_ATTRIBUTE, path.join(root, ...relative.split('/'))]);
    if (probe.code === 0) return true;
  }
  return false;
}

/**
 * @param {{ product: boolean, root: string | null, manifest: object | null }} layout
 * @param {{ platform?: string, xattr?: string, find?: string, log?: Function, run?: Function }} [options]
 *   run(command, args) => Promise<{ code, stdout, stderr }> permite simular las herramientas en las pruebas.
 * @returns {Promise<{ status: 'no-aplica' | 'sin-cuarentena' | 'retirada' | 'no-coincide' | 'error', aviso?: string, archivos?: number, problemas?: object[] }>}
 */
export async function releaseQuarantine(layout, {
  platform = process.platform, xattr = '/usr/bin/xattr', find = '/usr/bin/find', log = () => {}, run = runProgram,
} = {}) {
  if (platform !== 'darwin' || !layout?.product || !layout.root || !layout.manifest) return { status: 'no-aplica' };
  const root = layout.root;
  try {
    const runtime = productRuntime(root, layout.manifest, platform);
    const relative = file => path.relative(root,file).split(path.sep).join('/');
    const directories = runtime.directories ?? [runtime.directory];
    let files = 0, links = 0, removed = false;
    for (const directory of directories) {
      const platformFiles = [runtime.nodeExecutable,runtime.pythonExecutable]
        .filter(file=>file===directory || file.startsWith(directory+path.sep)).map(relative);
      const options = {root,platformFiles,find,xattr,run};
      if (!(await quarantined(directory,options))) continue;
      let result;
      try {
        const manifest = validateManifest(layout.manifest);
        result = await verifyTree(root,manifest,{prefix:relative(directory)});
      } catch(error) { result={ok:false,files:0,problems:[{path:relative(directory),problem:String(error?.message??error)}]}; }
      if(!result.ok || result.files===0) {
        const aviso=`Mind no retiró la cuarentena: los archivos incluidos no coinciden con su manifiesto (${describeProblems(result.problems)||'sin archivos verificables'}). Vuelve a extraer My Mind.`;
        log('error',aviso,{diferencias:result.problems.length});
        return {status:'no-coincide',aviso,problemas:result.problems};
      }
      const removal=await run(xattr,['-dr',QUARANTINE_ATTRIBUTE,directory]);
      if(await quarantined(directory,options)) {
        const aviso=`Mind verificó el ejecutor activo pero no pudo retirar su cuarentena (${(removal.stderr||`código ${removal.code}`).trim().slice(0,200)}).`;
        log('error',aviso);return {status:'error',aviso};
      }
      files+=result.files;links+=result.links;removed=true;
    }
    if(!removed)return {status:'sin-cuarentena'};
    log('info','Cuarentena retirada solo de los componentes del destino activo tras verificar sus hashes',{archivos:files,enlaces:links});
    return {status:'retirada',archivos:files};
  } catch (error) {
    const aviso = `Mind no pudo comprobar la cuarentena de macOS: ${String(error?.message ?? error).slice(0, 200)}`;
    log('error', aviso);
    return { status: 'error', aviso };
  }
}

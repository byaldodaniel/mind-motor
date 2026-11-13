import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readArchive } from './archive.js';
import { MotorError } from './errors.js';
import { readJson, writeJson } from './storage.js';
import { lockInstallation } from './installation-lock.js';
import { acquireOwnerFileLock, recoverAbandonedOwnerFile } from './process-identity.js';
import { liveSessions } from './session.js';
import { productPaths, productRuntime } from './layout.js';
import { stopCentralMotor } from './connector.js';
import { readManifestFile, hashFile, scanTree, verifyTree, comparePackageVersions, supportsProductTarget, validateManifest } from './product-files.js';

const error = (code, message) => new MotorError(code, message);
const has = async p => !!(await fs.lstat(p).catch(e => { if(e.code === 'ENOENT') return null; throw e; }));
const within = (a,b) => { const r = path.relative(a,b); return r === '' || (!r.startsWith('..'+path.sep) && r !== '..' && !path.isAbsolute(r)); };
const manifestPath = m => m.layoutVersion === 2 ? 'Sistema/mind-producto.json' : 'mind-producto.json';

async function drainIdleCentralMotor(baseDirectory, root, current) {
  const candidates = new Set([baseDirectory, productPaths(root, current).baseDirectory].filter(Boolean));
  for (const dir of candidates) {
    try {
      await stopCentralMotor(dir, { onlyIfIdle: true, timeoutMs: 8_000 });
    } catch {
      // Si el drenado no aplica o falla, sessionState decide si hay sesiones activas reales.
    }
  }
}
function relativePath(root,p) {
  const r = path.relative(root,p).split(path.sep).join('/');
  if (!r || r.split('/').some(s => s === '..' || s === '.' || !s) || path.isAbsolute(r)) throw error('UPDATE_JOURNAL_INVALID','Ruta fuera de la instalación.');
  return r;
}
function resolve(root,r) {
  if(typeof r !== 'string' || r.includes('\\') || r.split('/').some(s=>!s || s==='..' || s==='.') || path.isAbsolute(r)) throw error('UPDATE_JOURNAL_INVALID','Ruta no válida en diario.');
  return path.join(root,...r.split('/'));
}
async function noLinks(root,target) {
  if (!within(root,target)) throw error('UPDATE_PATH_INVALID','El destino sale de la instalación.');
  let p=root;
  for(const c of path.relative(root,target).split(path.sep).filter(Boolean)) {
    p=path.join(p,c); const i=await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(i?.isSymbolicLink()) throw error('UPDATE_PATH_LINK','Una ruta técnica es un enlace; no se modifica.');
  }
}
function groups(m) {
  const out = new Set();
  for(const r of [...Object.keys(m.files),...Object.keys(m.links??{})]) {
    if(m.layoutVersion !== 2 && /^(Motor|Runtime|LICENCIAS)\//u.test(r)) out.add(r.split('/')[0]);
    else if(r.startsWith('Sistema/Programa/Motor/')) out.add('Sistema/Programa/Motor');
    else if(/^Sistema\/Componentes\/(Node|Python)\/[^/]+\//u.test(r)) out.add(r.split('/').slice(0,4).join('/'));
    else if(r.startsWith('Sistema/Componentes/Semantica/')) out.add('Sistema/Componentes/Semantica');
    else if(r.startsWith('Sistema/Licencias/')) out.add('Sistema/Licencias');
    else out.add(r);
  }
  out.add(manifestPath(m));
  if(m.layoutVersion===2) out.add('Sistema/entrega-firmada.json');
  return [...out].sort();
}
const subset = (m,g) => JSON.stringify([Object.entries(m.files).filter(([p])=>p===g||p.startsWith(g+'/')).sort(),Object.entries(m.links??{}).filter(([p])=>p===g||p.startsWith(g+'/')).sort()]);
async function unchanged(root,current,incoming,g) {
  if(subset(current,g)!==subset(incoming,g) || g===manifestPath(incoming) || g.endsWith('entrega-firmada.json'))return false;
  const entries=Object.entries(incoming.files).filter(([p])=>p===g||p.startsWith(g+'/'));
  if(!entries.length)return false;
  for(const [p,h]of entries){const f=resolve(root,p); if(!(await has(f)) || (await fs.lstat(f)).isSymbolicLink() || await hashFile(f)!==h)return false;}
  for(const [p,t]of Object.entries(incoming.links??{}).filter(([p])=>p===g||p.startsWith(g+'/'))){if(await fs.readlink(resolve(root,p)).catch(()=>null)!==t)return false;}
  return true;
}
async function lease(file,pythonExecutable) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  try { return await acquireOwnerFileLock(file,{pythonExecutable,timeoutMs:0}); }
  catch(e){if(e.code === 'LOCK_BUSY')throw error('UPDATE_IN_PROGRESS','Otra actualización está activa o no puede verificarse.');throw e;}
}
async function sessionState(base,root,current,pythonExecutable){
  const directories=[base,productPaths(root,current).installationStateDirectory];
  if(current.layoutVersion===2)directories.push(path.join(root,'.mind-producto'));
  const active=new Map(), unknown=new Map();
  for(const d of new Set(directories)){
    const s=await liveSessions(d,{pythonExecutable});
    for(const x of s.unknown??[])unknown.set(x.id??x.file,x);
    for(const x of s.live)if(!unknown.has(x.id??x.file))active.set(x.id??x.file,x);
    for(const x of s.stale){const directory=s.directory??path.join(d,'sesiones');if(x.file)await recoverAbandonedOwnerFile(path.join(directory,x.file),{pythonExecutable});}
  }
  for(const k of unknown.keys())active.delete(k);
  if(active.size||unknown.size)throw Object.assign(error(unknown.size?'SESSION_IDENTITY_UNKNOWN':'MIND_IN_USE',`${active.size} sesiones activas y ${unknown.size} no verificables; la actualización queda preparada.`),{active:active.size,unknown:unknown.size});
}
async function safeRemove(root,p){await noLinks(root,p);if(!within(root,p)||p===root)throw error('UPDATE_PATH_INVALID','No se elimina fuera de la transacción.');await fs.rm(p,{recursive:true,force:true});}
async function durableMove(root,journalFile,journal,from,to,testing,{copy=false}={}){
  await noLinks(root,from);await noLinks(root,path.dirname(to));
  const toExists=await has(to),fromInfo=await fs.lstat(from);
  const replace=!copy&&toExists&&fromInfo.isFile()&&(await fs.lstat(to)).isFile();
  if(toExists&&!replace)throw error('UPDATE_TARGET_EXISTS',`Ya existe ${to}.`);
  const op={from:relativePath(root,from),to:relativePath(root,to),kind:copy?'copy':replace?'replace':'move',done:false};
  if(fromInfo.isFile())op.hash=await hashFile(from);
  journal.operations.push(op);await writeJson(journalFile,journal);await fs.mkdir(path.dirname(to),{recursive:true});
  if(copy){
    const temporary=to+'.parcial';await fs.copyFile(from,temporary);
    if(await hashFile(temporary)!==op.hash)throw error('UPDATE_COPY_ALTERED','El archivo cambió al preparar recuperación.');
    const f=await fs.open(temporary,'r+');try{await f.sync();}finally{await f.close();}
    await fs.rename(temporary,to);
  }else await (testing.rename??fs.rename)(from,to);
  op.done=true;await writeJson(journalFile,journal);
  await testing.afterMove?.(journal.phase==='base'?'base':journal.phase==='placing'?'placed':'aside',relativePath(root,from));
}
async function rollback(root,file,j){
  for(const op of [...j.operations].reverse()){
    const a=resolve(root,op.from), b=resolve(root,op.to);await noLinks(root,a);await noLinks(root,b);
    const ah=await has(a),bh=await has(b);
    if(op.kind==='copy'){
      if(bh){if(await hashFile(b)!==op.hash)throw error('UPDATE_ROLLBACK_FAILED','La recuperación no coincide con su huella.');await fs.mkdir(path.dirname(a),{recursive:true});await fs.rename(b,a);}
      else if(!ah)throw error('UPDATE_ROLLBACK_FAILED','Falta el original de un archivo.');
    }else if(bh&&!ah){
      if(op.hash&&await hashFile(b)!==op.hash)throw error('UPDATE_ROLLBACK_FAILED','Un archivo cambió después de la interrupción.');
      await fs.mkdir(path.dirname(a),{recursive:true});await fs.rename(b,a);
    }else if(ah&&bh&&op.kind==='replace'){
      // Planned atomic replacement did not take place: the source is still there.
      if(await hashFile(a)!==op.hash)throw error('UPDATE_ROLLBACK_FAILED','La preparación cambió.');
    }else if(ah&&bh)throw error('UPDATE_ROLLBACK_FAILED','Ambos extremos existen; se conserva la recuperación.');
    else if(!ah&&!bh)throw error('UPDATE_ROLLBACK_FAILED','Faltan ambos extremos de una operación.');
  }
  j.phase='rolled-back';j.operations=[];await writeJson(file,j);
}
export async function checkPreparationSpace(root,source,{statfs=fs.statfs,workerBytes=0}={}){
  const info=await fs.lstat(source);let bytes=0,count=0;
  if(info.isDirectory())for(const e of await scanTree(source)){if(e.type==='file'){bytes+=e.size;count++;}}
  else for await(const e of readArchive(source)){bytes+=e.size??0;count++;if(!Number.isSafeInteger(bytes)||bytes>4*1024**3||count>100000)throw error('UPDATE_PACKAGE_TOO_LARGE','El paquete excede los límites de preparación.');}
  const disk=await statfs(root);const available=Number(disk.bavail)*Number(disk.bsize),required=bytes+workerBytes+64*1024**2;
  if(!Number.isFinite(available)||available<required)throw Object.assign(error('UPDATE_DISK_SPACE','No hay espacio para preparar la actualización y su recuperación temporal.'),{available,required});
  return {available,required,bytes};
}
async function recoveryWorker(work,pythonExecutable){
  if(!path.isAbsolute(pythonExecutable))throw error('UPDATE_PYTHON_PATH','La recuperación requiere la ruta absoluta del Python incluido.');
  const worker=path.join(work,'recuperador'), motor=path.join(worker,'Motor');
  const ownMotor=fileURLToPath(new URL('..',import.meta.url));
  for(const dir of ['src','bin'])await fs.cp(path.join(ownMotor,dir),path.join(motor,dir),{recursive:true});
  await fs.copyFile(path.join(ownMotor,'package.json'),path.join(motor,'package.json'));
  const node=path.join(worker,'Node',process.platform==='win32'?'node.exe':'bin/node');await fs.mkdir(path.dirname(node),{recursive:true});await fs.copyFile(process.execPath,node);await fs.chmod(node,0o755);
  const pyRoot=process.platform==='win32'?path.dirname(pythonExecutable):path.dirname(path.dirname(pythonExecutable));
  const packageRoot=path.join(work,'paquete');
  if(!within(packageRoot,pyRoot))throw error('UPDATE_PYTHON_PATH','Solo se copia el Python verificado del paquete preparado.');
  await fs.cp(pyRoot,path.join(worker,'Python'),{recursive:true});
}
// Exact manifest bytes from previously verified public deliveries; a self-described tree is not provenance.
const HISTORICAL_MANIFESTS = new Set(["ec878e961a38f83def1c9c8e09052410929a2147f9602060dd62f02fed357e8a","48a7b34364d85c525520ed29fea9e6f0329e349def9903b614c99c8bf0aae1a4", "eb438167fd9e9f51af42f4de156f12761a4e6336cd02da8bb9397ca419ed11c2", "c1ec1412d99902819e22a4bc17307f638cccd19386c22966b56290aec230b641", "dfb3a0d0f94f9e373f9691002db3c79cd9fc3e4696ff011eee9d2b18982dbffe"]);
async function cleanupObsolete(root,j){
  const live=new Set(groups(j.incomingManifest));live.add('.mcp.json');
  for(const op of j.operations){
    if(op.kind!=='copy'||live.has(op.from))continue;
    const file=resolve(root,op.from);
    if(await has(file)){
      if(await hashFile(file)!==op.hash)throw error('UPDATE_CLEANUP_CHANGED','Un archivo anterior cambió; se conserva.');
      await fs.unlink(file);
    }
  }
}
async function cleanLegacy(root){
  const preserved=[];
  for(const name of await fs.readdir(root)){
    const previous=/^\.anterior-[0-9]/u.test(name),staging=/^\.mind-actualizacion-[A-Za-z0-9_-]+$/u.test(name);
    if(!previous&&!staging)continue;
    const candidate=path.join(root,name);const info=await fs.lstat(candidate);
    if(!info.isDirectory()||info.isSymbolicLink())continue;
    let packageRoot=candidate;
    if(staging){
      const direct=path.join(candidate,'paquete'),extracted=path.join(candidate,'extraido');
      if(await has(direct))packageRoot=direct;
      else if(await has(extracted)){
        const children=await fs.readdir(extracted);if(children.length!==1){preserved.push(name);continue;}packageRoot=path.join(extracted,children[0]);
      }else{preserved.push(name);continue;}
    }
    const m=await readManifestFile(packageRoot).catch(()=>null);
    if(!m||!HISTORICAL_MANIFESTS.has(await hashFile(productPaths(packageRoot,m).manifestFile))){preserved.push(name);continue;}
    const verified=await verifyTree(packageRoot,m,{ignoreBytecode:true}).catch(()=>({ok:false}));
    if(!verified.ok){preserved.push(name);continue;}
    if(staging){
      const prefix=path.relative(candidate,packageRoot).split(path.sep).join('/')+'/';
      if((await scanTree(candidate)).some(e=>!e.path.startsWith(prefix)&&!/(?:^|\/)__pycache__\/[^/]+\.pyc$/iu.test(e.path))){preserved.push(name);continue;}
      const lock=path.join(root,'.mind-actualizacion.lock');
      if(await has(lock)&&!(await recoverAbandonedOwnerFile(lock))){preserved.push(name);continue;}
    }
    await safeRemove(root,candidate);
  }
  return preserved;
}
async function recoverTransactionLocked(root,{pythonExecutable}={}){
  root=await fs.realpath(root);const directory=path.join(root,'Sistema','Actualizaciones');const file=path.join(directory,'transaccion.json');
  const stored=await readJson(file);if(!stored)return {status:'sin-operacion'};
  const j=stored.data;
  if(j.format!=='mind-update-transaction'||j.version!==1||!Array.isArray(j.operations)||j.work!=='Sistema/Actualizaciones/Trabajo/actual')throw error('UPDATE_JOURNAL_INVALID','Diario no válido; se conserva.');
  const work=resolve(root,j.work);await noLinks(root,work);
  if(j.operations.length){
    validateManifest(j.currentManifest);validateManifest(j.incomingManifest);
    if(!j.currentManifest||!j.incomingManifest)throw error('UPDATE_JOURNAL_INVALID','Falta el inventario de la transacción.');
    const allowed=new Set();
    for(const g of groups(j.currentManifest))allowed.add(`${g}=>${j.work}/recuperacion/${g}`);
    for(const g of groups(j.incomingManifest))allowed.add(`${j.work}/paquete/${g}=>${g}`);
    allowed.add('Base=>Sistema/Base');
    allowed.add(`.mcp.json=>${j.work}/recuperacion/.mcp.json`);
    allowed.add(`${j.work}/configuracion/.mcp.json=>.mcp.json`);
    for(const op of j.operations)if(!allowed.has(`${op.from}=>${op.to}`))throw error('UPDATE_JOURNAL_INVALID','Una operación no pertenece al paquete.');
  }
  let releaseGate;
  if(!['prepared','committed','cleanup-pending','rolled-back'].includes(j.phase)){
    releaseGate=await lockInstallation(root,{pythonExecutable});
    try{
      const manifests=[j.currentManifest,j.incomingManifest].filter(Boolean);
      for(const manifest of manifests)for(const base of new Set([j.baseDirectory,productPaths(root,manifest).baseDirectory].filter(Boolean)))await sessionState(base,root,manifest,pythonExecutable);
      await rollback(root,file,j);
    }finally{await releaseGate();}
  }
  if(j.phase==='prepared')return {status:'preparada',journal:j};
  try {if(j.phase==='committed'||j.phase==='cleanup-pending')await cleanupObsolete(root,j);await safeRemove(root,work);await fs.rm(file);return {status:'recuperada'};}
  catch(e){j.phase='cleanup-pending';j.cleanupError=e.code;await writeJson(file,j);throw error('UPDATE_CLEANUP_PENDING','La limpieza anterior sigue pendiente; no se inicia otra operación.');}
}
export async function recoverUpdateTransaction(root,options={}){
  const file=path.join(root,'Sistema','Actualizaciones','transaccion.json');
  if(!(await has(file)))return {status:'sin-operacion'};
  let release;
  try{
    if(!options.leaseHeld)release=await lease(path.join(path.dirname(file),'preparacion.lock'),options.pythonExecutable);
    return await recoverTransactionLocked(root,options);
  }finally{await release?.();}
}
export async function runUpdateTransaction(options,h){
  let {root,source,baseDirectory,confirm=()=>true,force=false,report=()=>{},verifyInstalled=h.smokeTest,testing={},expectedRelease,expectedManifestSha256,pythonExecutable}=options;
  root=await fs.realpath(path.resolve(root));let current=await readManifestFile(root);
  if(current)pythonExecutable??=process.env.MIND_PYTHON??productRuntime(root,current).pythonExecutable;
  const directory=path.join(root,'Sistema','Actualizaciones');await noLinks(root,directory);await fs.mkdir(directory,{recursive:true});
  const release=await lease(path.join(directory,'preparacion.lock'),pythonExecutable);
  const journalFile=path.join(directory,'transaccion.json');const work=path.join(directory,'Trabajo','actual');
  let unlockGate, j, tree, incoming, committed=false,createdWork=false,createdJournal=false;
  try{
    const recovered=await recoverUpdateTransaction(root,{pythonExecutable,leaseHeld:true});
    current=await readManifestFile(root);if(!current)throw error('NOT_PRODUCT','No es una instalación de Mind.');
    baseDirectory=path.resolve(baseDirectory??productPaths(root,current).baseDirectory);
    baseDirectory=await fs.realpath(baseDirectory).catch(e=>{if(e.code==='ENOENT')return baseDirectory;throw e;});
    if(recovered.status==='preparada'){
      j=recovered.journal;tree=path.join(work,'paquete');incoming=await readManifestFile(tree);
      if(!incoming || !(await verifyTree(tree,incoming)).ok)throw error('UPDATE_PREPARED_INVALID','El paquete preparado ya no coincide; se conserva para revisión.');
      if(source && path.resolve(source)!==j.source)throw error('UPDATE_PREPARED_EXISTS','Ya existe otra actualización preparada.');
    }else{
      if(!source) return {status:'sin-operacion'};
      source=await fs.realpath(path.resolve(source));
      if((within(root,source)&&!within(path.join(directory,'descargas'),source))||within(source,root))throw error('UPDATE_SOURCE_INVALID','El paquete debe estar fuera del programa o en su descarga técnica.');
      const workerBytes=verifyInstalled===h.smokeTest?384*1024**2:0;
      await checkPreparationSpace(root,source,{statfs:testing.statfs,workerBytes});
      await fs.mkdir(work,{recursive:true});createdWork=true;
      const prepared=await h.prepare(source,work,report);tree=prepared.tree;incoming=prepared.manifest;
      j={format:'mind-update-transaction',version:1,work:relativePath(root,work),source,phase:'prepared',operations:[],from:current.mindVersion,to:incoming.mindVersion,currentManifest:current,incomingManifest:incoming,baseDirectory};await writeJson(journalFile,j);createdJournal=true;
    }
    if(expectedRelease)for(const k of ['mindVersion','packageRevision','layoutVersion','updateProtocolVersion'])if(expectedRelease[k]!==undefined&&(incoming[k]??(k==='packageRevision'?0:1))!==expectedRelease[k])throw error('UPDATE_RELEASE_MISMATCH','El paquete no coincide con el canal firmado.');
    if(expectedManifestSha256 && await hashFile(productPaths(tree,incoming).manifestFile)!==expectedManifestSha256)throw error('UPDATE_MANIFEST_MISMATCH','El manifiesto no coincide con la entrega firmada.');
    const target=current.targets?process:current;
    if(!supportsProductTarget(current,target.platform,target.arch)||!supportsProductTarget(incoming,target.platform,target.arch))throw error('UPDATE_PLATFORM_MISMATCH','El paquete no admite este equipo.');
    const order=comparePackageVersions(incoming,current);
    if(order<0&&!force)throw error('UPDATE_DOWNGRADE','El paquete es anterior a la entrega instalada.');
    if(order===0&&await hashFile(productPaths(root,current).manifestFile)!==await hashFile(productPaths(tree,incoming).manifestFile))throw error('UPDATE_IDENTITY_CONFLICT','La misma versión y revisión tiene contenido diferente.');
    const items=[...new Set([...groups(current),...groups(incoming)])];
    await h.protectBase(root,baseDirectory,items);
    const supported=await h.supportedBaseFormat(tree,incoming),stored=await h.baseFormat(baseDirectory);
    if(stored!==null&&stored>supported)throw error('UPDATE_BASE_INCOMPATIBLE','El paquete no admite el formato de esta Base.');
    const summary={from:current.mindVersion,to:incoming.mindVersion,fromRevision:current.packageRevision??0,toRevision:incoming.packageRevision??0,platform:`${target.platform}-${target.arch}`,files:Object.keys(incoming.files).length,downgrade:order<0,reinstall:order===0,base:stored===null?'sin crear':`formato ${stored}`,supportedBase:supported};
    if(!(await confirm(summary))){await safeRemove(root,work);await fs.rm(journalFile);return {status:'cancelada',...summary};}
    unlockGate=await lockInstallation(root,{pythonExecutable});
    await drainIdleCentralMotor(baseDirectory,root,current);
    try{await sessionState(baseDirectory,root,current,pythonExecutable);}catch(e){if(['MIND_IN_USE','SESSION_IDENTITY_UNKNOWN'].includes(e.code)){e.prepared=true;report(e.message);}throw e;}
    const keep=new Set();for(const g of groups(incoming))if(await unchanged(root,current,incoming,g))keep.add(g);
    let previousMcp;
    if(await has(path.join(root,'.mcp.json')))previousMcp=await readJson(path.join(root,'.mcp.json'));
    for(const name of ['AGENTS.md','CLAUDE.md','GEMINI.md']){
      if(current.files[name] && await has(path.join(root,name)) && await hashFile(path.join(root,name))!==current.files[name])keep.add(name);
    }
    if(order===0){await safeRemove(root,work);await fs.rm(journalFile);return {status:'al-dia',...summary};}
    const baseTarget=incoming.layoutVersion===2&&baseDirectory===path.join(root,'Base')?path.join(root,'Sistema','Base'):baseDirectory;
    const beforeBase=await has(baseDirectory)?await scanTree(baseDirectory):[];
    const baseHashes={};for(const e of beforeBase)if(e.type==='file')baseHashes[e.path]=await hashFile(path.join(baseDirectory,e.path));
    let stagedMcp;
    if(previousMcp){
      const old=previousMcp.data,entry=old.mcpServers?.mind;
      const owned=entry&&typeof entry.command==='string'&&Array.isArray(entry.args)&&/^(?:Motor[\\/]|Sistema[\\/]Programa[\\/]Motor[\\/])/u.test(entry.args[0]??'');
      const next=owned?{...entry,command:path.relative(root,productRuntime(root,incoming).nodeExecutable).split(path.sep).join('/'),args:[path.relative(root,productPaths(root,incoming).agentEntrypoint).split(path.sep).join('/'),...entry.args.slice(1)]}:entry;
      if(next&&baseTarget!==baseDirectory)for(let i=0;i<next.args.length-1;i++)if(next.args[i]==='--base'){
        const previous=next.args[i+1];
        if(path.isAbsolute(previous)&&await fs.realpath(previous).catch(()=>null)===baseDirectory)next.args[i+1]=baseTarget;
      }
      const merged={...old,mcpServers:{...(old.mcpServers??{}),...(next?{mind:next}:{})}};
      stagedMcp=path.join(work,'configuracion','.mcp.json');await fs.mkdir(path.dirname(stagedMcp),{recursive:true});await writeJson(stagedMcp,merged);
    }
    if(verifyInstalled===h.smokeTest&&incoming.layoutVersion===2)await recoveryWorker(work,productRuntime(tree,incoming).pythonExecutable);
    j.phase='aside';await writeJson(journalFile,j);
    for(const item of [...new Set([...groups(current),...(previousMcp?['.mcp.json']:[])])]){
      if(keep.has(item))continue;const live=resolve(root,item);if(!(await has(live)))continue;
      const stat=await fs.lstat(live);
      if(stat.isDirectory()){
        const check=await verifyTree(root,current,{prefix:item,ignoreBytecode:true});
        if(check.problems.some(p=>p.problem==='sobrante'))throw error('UPDATE_UNMANAGED_CONTENT',`Hay archivos ajenos en ${item}; se conservan.`);
      }
      await durableMove(root,journalFile,j,live,path.join(work,'recuperacion',...item.split('/')),testing,{copy:stat.isFile()});
    }
    j.phase='placing';await writeJson(journalFile,j);
    for(const item of groups(incoming)){
      if(keep.has(item)||item==='.mcp.json'&&stagedMcp)continue;const fresh=resolve(tree,item);if(!(await has(fresh)))continue;
      await durableMove(root,journalFile,j,fresh,resolve(root,item),testing);
    }
    if(baseTarget!==baseDirectory&&await has(baseDirectory)){
      j.phase='base';await writeJson(journalFile,j);await durableMove(root,journalFile,j,baseDirectory,baseTarget,testing);
    }
    if(stagedMcp)await durableMove(root,journalFile,j,stagedMcp,path.join(root,'.mcp.json'),testing);
    j.phase='verifying';await writeJson(journalFile,j);await testing.afterPhase?.('verifying');
    await verifyInstalled(root,incoming);
    for(const [r,hash]of Object.entries(baseHashes))if(await hashFile(path.join(baseTarget,r))!==hash)throw error('UPDATE_BASE_CHANGED','La Base cambió durante la instalación.');
    j.phase='committed';await writeJson(journalFile,j);committed=true;await testing.afterPhase?.('committed');
    let preservedLegacy=[];
    try{await cleanupObsolete(root,j);preservedLegacy=await cleanLegacy(root);await safeRemove(root,work);await fs.rm(journalFile);}
    catch(e){j.phase='cleanup-pending';j.cleanupError=e.code;await writeJson(journalFile,j);return {status:'actualizada',...summary,cleanupPending:true,baseDirectory:baseTarget,baseMigration:baseTarget!==baseDirectory?{from:baseDirectory,to:baseTarget}:null};}
    return {status:'actualizada',...summary,cleanupPending:false,baseDirectory:baseTarget,baseMigration:baseTarget!==baseDirectory?{from:baseDirectory,to:baseTarget}:null,reusedComponents:keep.size,preservedLegacy};
  }catch(e){
    if(j&&!committed&&j.phase!=='prepared'){
      try{await rollback(root,journalFile,j);await safeRemove(root,work);await fs.rm(journalFile);}catch(failure){throw Object.assign(error('UPDATE_ROLLBACK_FAILED',`Se conserva la recuperación: ${failure.message}`),{cause:e});}
    }else if(!e.prepared && createdJournal && j?.phase==='prepared'){
      await safeRemove(root,work);await fs.rm(journalFile);
    }else if(!j&&createdWork&&await has(work))await safeRemove(root,work);
    throw e;
  }finally{await unlockGate?.();await release();}
}

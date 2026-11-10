import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {productPaths,productRuntime} from '../src/layout.js';
import {validateManifest,comparePackageVersions,readManifestFile,verifyTree,UNIVERSAL_TARGETS} from '../src/product-files.js';
import {keepPythonPath,materializeRuntimeLinks} from '../scripts/construir-paquetes.mjs';
import {releaseQuarantine} from '../src/quarantine.js';
import {startupInstructions} from '../src/agent-startup.js';
const sha = value=>createHash('sha256').update(value).digest('hex');
const modern = files=>({format:'mind-product',version:1,mindVersion:'1.0.3',packageRevision:1,layoutVersion:2,updateProtocolVersion:2,platform:'win32',arch:'x64',targets:[...UNIVERSAL_TARGETS],files});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'mind-layout2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('layout 2 tiene componentes por destino y separa programa, datos y actualización',()=>{
 const root=path.resolve('My Mind'),manifest=modern({});const p=productPaths(root,manifest);
 assert.equal(p.motorDirectory,path.join(root,'Sistema','Programa','Motor'));
 assert.equal(p.baseDirectory,path.join(root,'Sistema','Base'));
 assert.equal(p.manifestFile,path.join(root,'Sistema','mind-producto.json'));
 assert.equal(p.updateDirectory,path.join(root,'Sistema','Actualizaciones'));
 for(const target of UNIVERSAL_TARGETS){const [platform,arch]=target.split('-');const r=productRuntime(root,manifest,platform,arch);
  assert.equal(r.nodeDirectory,path.join(root,'Sistema','Componentes','Node',target));
  assert.equal(r.pythonDirectory,path.join(root,'Sistema','Componentes','Python',target));
  assert.equal(r.directories.length,2);
 }
 const legacy=productPaths(root,{mindVersion:'1.0.3'});assert.equal(legacy.baseDirectory,path.join(root,'Base'));
 assert.equal(productRuntime(root,{targets:[...UNIVERSAL_TARGETS]},'linux','x64').pythonExecutable,path.join(root,'Runtime','linux-x64','python','bin','python3'));
});

test('revisión ordena paquetes iguales sin cambiar versión pública',()=>{
 assert.equal(comparePackageVersions({mindVersion:'1.0.3',packageRevision:1},{mindVersion:'1.0.3'}),1);
 assert.equal(comparePackageVersions({mindVersion:'1.0.3',packageRevision:1},{mindVersion:'1.0.3',packageRevision:1}),0);
 assert.equal(comparePackageVersions({mindVersion:'1.0.2',packageRevision:9},{mindVersion:'1.0.3'}),-1);
 for(const field of ['packageRevision','layoutVersion','updateProtocolVersion'])assert.throws(()=>validateManifest({...modern({}),[field]:-1}),{code:'PRODUCT_MANIFEST_INVALID'});
 for(const target of ['Sistema/Base/dato','Sistema/Estado/sesion','Sistema/Actualizaciones/Trabajo'])assert.throws(()=>validateManifest({...modern({}),targets:undefined,links:{'Manual':target}}),{code:'PRODUCT_MANIFEST_INVALID'});
 for(const relative of ['Sistema/Base/state.json','Sistema/Estado/sesion.json','Sistema/Actualizaciones/Trabajo/data','Sistema/entrega-firmada.json','sistema/MIND-PRODUCTO.json','sistema/ENTREGA-FIRMADA.JSON'])assert.throws(()=>validateManifest(modern({[relative]:'0'.repeat(64)})),{code:'PRODUCT_MANIFEST_INVALID'});
});

test('lector reconoce manifiesto nuevo y verificación solo exceptúa su descriptor reservado',async t=>{
 const root=await fixture(t);await fs.mkdir(path.join(root,'Sistema'),{recursive:true});
 const manifest=modern({'Sistema/app':'0'.repeat(64)});const file=path.join(root,'Sistema','mind-producto.json');await fs.writeFile(file,JSON.stringify(manifest));
 assert.equal((await readManifestFile(root)).layoutVersion,2);
 await fs.writeFile(path.join(root,'Sistema','app'),'app');manifest.files['Sistema/app']=sha('app');
 await fs.writeFile(path.join(root,'Sistema','entrega-firmada.json'),'descriptor verificado por módulo separado');
 assert.equal((await verifyTree(root,manifest)).ok,true);
 await fs.writeFile(path.join(root,'Sistema','desconocido'),'no permitido');
 assert.deepEqual((await verifyTree(root,manifest)).problems,[{path:'Sistema/desconocido',problem:'sobrante'}]);
});

test('perfil Python conserva dependencias de auxiliares y excluye GUI y herramientas',()=>{
 for(const value of ['Lib/threading.py','lib/python3.12/ctypes/__init__.py','lib/python3.12/xml/etree/ElementTree.py','lib/python3.12/lib-dynload/_ctypes.so','python.exe','bin/python3.12','lib/libpython3.12.so.1.0','lib/python3.12/LICENSE.txt'])assert.equal(keepPythonPath(value),true,value);
 for(const value of ['include/Python.h','Lib/site-packages/pip/__init__.py','lib/python3.12/site-packages/pip-25.0.1.dist-info/METADATA','lib/python3.12/ensurepip/__init__.py','Lib/__pycache__/abc.pyc','tcl/tcl8.6/init.tcl','lib/libtcl9.0.so','lib/python3.12/tkinter/__init__.py','DLLs/_tkinter.pyd','bin/pip3','bin/idle3','lib/python3.12/turtle.py','lib/libpython3.12.a'])assert.equal(keepPythonPath(value),false,value);
});

test('alias ejecutables Python son wrappers pequeños y conservan argumentos por exec',async t=>{
 const root=await fixture(t);await fs.mkdir(path.join(root,'bin'));const original=Buffer.from('ejecutable ficticio');await fs.writeFile(path.join(root,'bin','python3.12'),original);
 const result=await materializeRuntimeLinks(root,[{path:'bin/python3.12',type:'file',mode:0o755},{path:'bin/python3',type:'symlink',target:'python3.12',mode:0o755},{path:'bin/python',type:'symlink',target:'python3.12',mode:0o755}]);
 assert.equal(result.length,3);assert.ok(result.every(x=>x.type==='file'));
 const wrapper=await fs.readFile(path.join(root,'bin','python3'),'utf8');assert.match(wrapper,/exec "\$DIR\/python3\.12" "\$@"/);assert.ok(wrapper.length<256);
 assert.deepEqual(await fs.readFile(path.join(root,'bin','python3.12')),original);
});

test('instrucciones de inicio apuntan al Motor nuevo sin cambiar carpeta del proyecto',()=>{
 const root=path.resolve('My Mind');const r=productRuntime(root,modern({}),'win32','x64');const text=startupInstructions(root,r,'win32');
 assert.ok(text.includes(path.join(root,'Sistema','arranque.cjs')));assert.match(text,/sin cambiar de proyecto/);
});


test('cuarentena moderna verifica y retira solo Node y Python del destino activo',async t=>{
 const root=await fixture(t),manifest=modern({});const runtime=productRuntime(root,manifest,'darwin',process.arch);
 for(const file of [runtime.nodeExecutable,runtime.pythonExecutable]){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'ejecutor ficticio');manifest.files[path.relative(root,file).split(path.sep).join('/')]=sha('ejecutor ficticio');}
 const other=path.join(root,'Sistema','Componentes','Node','linux-arm64','bin','node');await fs.mkdir(path.dirname(other),{recursive:true});await fs.writeFile(other,'otro destino');
 const quarantined=new Set(runtime.directories);const removals=[];
 const run=async(command,args)=>{
  if(command==='find-ficticio')return {code:0,stdout:quarantined.has(args[0])?'cuarentena':'',stderr:''};
  if(args[0]==='-dr'){removals.push(args[2]);quarantined.delete(args[2]);return {code:0,stdout:'',stderr:''};}
  return {code:1,stdout:'',stderr:''};
 };
 const result=await releaseQuarantine({product:true,root,manifest},{platform:'darwin',run,find:'find-ficticio',xattr:'xattr-ficticio'});
 assert.equal(result.status,'retirada');assert.equal(result.archivos,2);assert.deepEqual(removals,runtime.directories);
 assert.ok(!removals.includes(path.dirname(path.dirname(other))));
});


test('producto extraído reconoce layout 2 desde su Motor real sin crear una Base',async t=>{
 const root=await fixture(t),manifest=modern({}),p=productPaths(root,manifest);
 const source=fileURLToPath(new URL('..',import.meta.url));await fs.mkdir(p.motorDirectory,{recursive:true});
 for(const item of ['src','bin'])await fs.cp(path.join(source,item),path.join(p.motorDirectory,item),{recursive:true});
 await fs.copyFile(path.join(source,'package.json'),path.join(p.motorDirectory,'package.json'));
 await fs.writeFile(p.manifestFile,JSON.stringify(manifest));
 const result=await promisify(execFile)(process.execPath,[p.entrypoint,'version'],{env:{...process.env,MIND_PYTHON:'python',MIND_UPDATE_RESTART:'1'}});
 const value=JSON.parse(result.stdout);assert.equal(value.producto,true);assert.equal(value.estructura,2);assert.equal(value.revision,1);
 await assert.rejects(fs.stat(p.baseDirectory),{code:'ENOENT'});
});

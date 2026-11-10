import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createResultCopier} from '../src/result-copier.js';

async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mind-verification-'));
 t.after(async()=>{assert.ok(path.basename(root).startsWith('mind-verification-'));await fs.rm(root,{recursive:true,force:true});});
 const value=Buffer.from([0,255,7,19,89]);await fs.writeFile(path.join(root,'image.bin'),value);
 let folder={id:'fixture',path:root,generation:'one',exclusions:[]};
 const copier=createResultCopier({loadAuthorizedFolder:async id=>id==='fixture'?folder:null});
 return {root,value,copier,requester:{},setFolder:value=>folder=value,get folder(){return folder;}};
}
test('verificación segura devuelve hash por permiso de un intento ligado al solicitante',async t=>{
 const f=await setup(t);
 const authorization=await f.copier.grantResultVerification({requester:f.requester,folderId:'fixture',relativePath:'image.bin'});
 await assert.rejects(f.copier.verifyResultFile({requester:{},authorization}),{code:'RESULT_VERIFICATION_NOT_AUTHORIZED'});
 let confirmed=0;
 const result=await f.copier.verifyResultFile({requester:f.requester,authorization,confirm:()=>{confirmed++;}});
 assert.equal(confirmed,1);assert.equal(result.size,f.value.length);assert.equal(result.sha256,createHash('sha256').update(f.value).digest('hex'));
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization}),{code:'RESULT_VERIFICATION_NOT_AUTHORIZED'});
 assert.deepEqual(await fs.readFile(path.join(f.root,'image.bin')),f.value);
 assert.deepEqual(await fs.readdir(f.root),['image.bin']);
});
test('retirar, cambiar generación o excluir invalida la comprobación concedida',async t=>{
 const f=await setup(t);
 const issue=()=>f.copier.grantResultVerification({requester:f.requester,folderId:'fixture',relativePath:'image.bin'});
 let authorization=await issue();f.setFolder({...f.folder,generation:'two'});
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization}),{code:'RESULT_VERIFICATION_NOT_AUTHORIZED'});
 authorization=await issue();f.setFolder({...f.folder,exclusions:['image.bin']});
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization}),{code:'PATH_EXCLUDED'});
 f.setFolder({...f.folder,exclusions:[]});authorization=await issue();f.setFolder(null);
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization}),{code:'COPY_NOT_AUTHORIZED'});
});
test('se revalida al confirmar y nunca se acepta una comprobación cuyo permiso falla',async t=>{
 const f=await setup(t);
 const authorization=await f.copier.grantResultVerification({requester:f.requester,folderId:'fixture',relativePath:'image.bin'});
 const refused=Object.assign(new Error('Acceso retirado'),{code:'ACCESS_NOT_GRANTED'});
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization,confirm:()=>{throw refused;}}),{code:'ACCESS_NOT_GRANTED'});
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization}),{code:'RESULT_VERIFICATION_NOT_AUTHORIZED'});
});
test('no se verifican enlaces físicos ni rutas que escapen de la carpeta',async t=>{
 const f=await setup(t);
 await fs.link(path.join(f.root,'image.bin'),path.join(f.root,'linked.bin'));
 const authorization=await f.copier.grantResultVerification({requester:f.requester,folderId:'fixture',relativePath:'image.bin'});
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization}),{code:'UNSAFE_PATH'});
 await assert.rejects(f.copier.grantResultVerification({requester:f.requester,folderId:'fixture',relativePath:'../outside.bin'}),{code:'INVALID_DESTINATIONS'});
});

test('no sigue una carpeta enlazada aunque el destino quede dentro del ámbito',async t=>{
 const f=await setup(t);
 const real=path.join(f.root,'real');await fs.mkdir(real);await fs.writeFile(path.join(real,'note.bin'),'Ficticio.');
 try{await fs.symlink(real,path.join(f.root,'redirect'),process.platform==='win32'?'junction':'dir');}
 catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('El sistema no permite crear el enlace de ensayo.');return;}throw error;}
 const authorization=await f.copier.grantResultVerification({requester:f.requester,folderId:'fixture',relativePath:'redirect/note.bin'});
 await assert.rejects(f.copier.verifyResultFile({requester:f.requester,authorization}),{code:'UNSAFE_PATH'});
});
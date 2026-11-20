import {spawnFileHelper} from './native-file-helper.js';
import {fileURLToPath} from 'node:url';
import {MotorError} from './errors.js';
import {isExcluded} from './paths.js';
import {outputName} from './work-destinations.js';
const helper=fileURLToPath(new URL('./native_result_copy.py',import.meta.url));
const allowedErrors=new Set(['ACCESS_DENIED','FILE_EXISTS','PARENT_NOT_FOUND','FILE_NOT_FOUND','UNSAFE_PATH','NO_SPACE','SOURCE_CHANGED','FILE_TOO_LARGE','SAFE_OPEN_UNAVAILABLE']);
export function copyResultNative(request,{pythonExecutable,nativeFilesExecutable,confirm}) {
  return new Promise((resolve,reject)=>{
    const child=spawnFileHelper({pythonExecutable,script:helper,nativeFilesExecutable,operation:'copiar-resultado',writes:true});
    let out='',diagnostic='',confirmed=false,failure;
    const fail=error=>{failure??=error;child.kill();};
    const timer=setTimeout(()=>fail(new MotorError(confirmed?'COPY_UNCONFIRMED':'COPY_FAILED','No se pudo confirmar la copia en el tiempo previsto.')),120000);
    child.stdin.on('error',()=>{});
    child.on('error',()=>fail(new MotorError('SAFE_OPEN_UNAVAILABLE','No está disponible el auxiliar seguro de copia.')));
    child.stdout.on('data',data=>{out+=data;if(out.length>4096)fail(new MotorError('COPY_UNCONFIRMED','Respuesta de copia no válida.'));});
    child.stderr.on('data',data=>{
      diagnostic=(diagnostic+data).replace(/\r\n/g,'\n');
      if(diagnostic.length>2048)return fail(new MotorError('COPY_FAILED','Respuesta de copia no válida.'));
      if(diagnostic.startsWith('READY\n')&&!confirmed){
        confirmed=true;
        Promise.resolve().then(confirm).then(()=>{if(!failure)child.stdin.end('W');}).catch(fail);
      }
    });
    child.on('close',code=>{
      clearTimeout(timer);
      if(failure)return reject(failure);
      if(code!==0){const reason=diagnostic.replace('READY\n','').trim();return reject(new MotorError(allowedErrors.has(reason)?reason:'COPY_FAILED','La copia no se completó: '+reason.slice(0,100)));}
      try{const result=JSON.parse(out);if(!Number.isSafeInteger(result.size)||result.size<0||!/^[a-f0-9]{64}$/.test(result.sha256))throw new Error();resolve(result);}
      catch{reject(new MotorError('COPY_UNCONFIRMED','El destino puede existir, pero no se pudo confirmar su copia.'));}
    });
    child.stdin.write(JSON.stringify(request)+'\n');
  });
}
export function createResultCopier({loadAuthorizedFolder,pythonExecutable=process.platform==='win32'?'python':'python3',nativeFilesExecutable}) {
  const grants=new WeakMap();
  const verifications=new WeakMap();
  const denyVerification=()=>new MotorError('RESULT_VERIFICATION_NOT_AUTHORIZED','No hay permiso vigente para esta comprobación.');
  const deny=()=>new MotorError('COPY_NOT_AUTHORIZED','No hay permiso vigente para esta copia.');
  async function scope(folderId,relativePath) {
    const folder=await loadAuthorizedFolder(folderId);
    if(!folder)throw deny();
    if(isExcluded(folder.exclusions,relativePath))throw new MotorError('PATH_EXCLUDED','El usuario excluyó esta ubicación.');
    return folder;
  }
  return {
    async grantResultVerification({requester,folderId,relativePath}={}) {
      if(!requester||typeof requester!=='object')throw denyVerification();
      const relative=outputName(relativePath),folder=await scope(folderId,relative);
      const authorization=Object.freeze(Object.create(null));
      verifications.set(authorization,{requester,folderId,relative,generation:folder.generation,used:false});
      return authorization;
    },
    async verifyResultFile({requester,authorization,confirm}={}) {
      const grant=verifications.get(authorization);
      if(!grant||grant.used||grant.requester!==requester)throw denyVerification();
      grant.used=true;
      const validate=async()=>{
        const folder=await scope(grant.folderId,grant.relative);
        if(folder.generation!==grant.generation)throw denyVerification();
        return folder;
      };
      const folder=await validate();
      const value=await copyResultNative({verifyOnly:true,sourceRoot:folder.path,sourcePath:grant.relative,maxBytes:4*1024**3},
        {pythonExecutable,nativeFilesExecutable,confirm:async()=>{await validate();await confirm?.();}});
      return {...value,folderId:folder.id,relativePath:grant.relative};
    },
    async grantResultCopy({requester,sourceFolderId,sourcePath,targetFolderId,targetPath}={}) {
      if(!requester||typeof requester!=='object')throw deny();
      const from=outputName(sourcePath),to=outputName(targetPath);
      const source=await scope(sourceFolderId,from),target=await scope(targetFolderId,to);
      const authorization=Object.freeze(Object.create(null));
      grants.set(authorization,{requester,sourceFolderId,targetFolderId,from,to,sourceGeneration:source.generation,targetGeneration:target.generation,used:false});
      return authorization;
    },
    async copyResultFile({requester,authorization,confirm}={}) {
      const grant=grants.get(authorization);
      if(!grant||grant.used||grant.requester!==requester)throw deny();
      grant.used=true;
      const validate=async()=>{
        const source=await scope(grant.sourceFolderId,grant.from),target=await scope(grant.targetFolderId,grant.to);
        if(source.generation!==grant.sourceGeneration||target.generation!==grant.targetGeneration)throw deny();
        return {source,target};
      };
      const {source,target}=await validate();
      const result=await copyResultNative({sourceRoot:source.path,sourcePath:grant.from,targetRoot:target.path,targetPath:grant.to,maxBytes:4*1024**3},{pythonExecutable,nativeFilesExecutable,confirm:async()=>{await validate();await confirm?.();}});
      return {...result,folderId:target.id,relativePath:grant.to};
    }
  };
}

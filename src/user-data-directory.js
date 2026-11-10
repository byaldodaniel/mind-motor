import fs from 'node:fs/promises';
import path from 'node:path';
import {MotorError} from './errors.js';
export async function ensureUserDataDirectory(layout) {
  if(!layout.userDataDirectory)return;
  const root=await fs.realpath(layout.root);
  const wanted=path.join(root,'Conversaciones');
  if(path.resolve(layout.userDataDirectory)!==path.resolve(wanted))throw new MotorError('INVALID_USER_DATA_DIRECTORY','El almacén predeterminado no corresponde a esta instalación.');
  try{await fs.mkdir(wanted,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const info=await fs.lstat(wanted);
  if(!info.isDirectory()||info.isSymbolicLink()||path.relative(wanted,await fs.realpath(wanted))!=='')throw new MotorError('UNSAFE_USER_DATA_DIRECTORY','El almacén predeterminado debe ser una carpeta real de esta instalación.');
}

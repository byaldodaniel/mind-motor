import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createCustomIndexExtension} from '../src/custom-index.js';
const definition={id:'ficticio',update:'al_cambiar',source:{folderId:'carpeta'},destination:{folderId:'carpeta',relativePath:'indice.csv'},problems:[]};
test('cerrar el índice espera una regeneración iniciada antes de liberar la sesión',async()=>{
 let listener,release,entered;const started=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);
 const session={onChanges(fn){listener=fn;return()=>{};},log(){}};
 const extension=createCustomIndexExtension(session,{debounceMs:1,indexes:{async list(){return[definition];},async regenerate(){entered();await barrier;}}});
 await extension.start();await listener({folderId:'carpeta',changes:{added:['nuevo.txt'],modified:[],removed:[]}});
 const keepAlive=delay(20);await started;await keepAlive;
 let closed=false;const closing=extension.close().then(()=>closed=true);
 try{await delay(10);assert.equal(closed,false);}finally{release();await closing;}
 assert.equal(closed,true);
});
test('un aviso cuya lectura termina después del cierre no programa nuevas escrituras',async()=>{
 let listener,release;const barrier=new Promise(resolve=>release=resolve);let writes=0;
 const extension=createCustomIndexExtension({onChanges(fn){listener=fn;return()=>{};},log(){}},{debounceMs:1,indexes:{async list(){await barrier;return[definition];},async regenerate(){writes++;}}});
 await extension.start();const notice=listener({folderId:'carpeta',changes:{added:['nuevo.txt'],modified:[],removed:[]}});
 await extension.close();release();await notice;await delay(20);assert.equal(writes,0);
});

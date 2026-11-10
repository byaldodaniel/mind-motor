import test from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest} from '../src/product-files.js';
test('el paquete nunca puede sustituir conversaciones del usuario, tampoco mediante enlaces',()=>{
 const manifest={format:'mind-product',version:1,mindVersion:'1.0.3',platform:'linux',arch:'x64',files:{'Motor/app.js':'0'.repeat(64)},links:{}};
 assert.doesNotThrow(()=>validateManifest(manifest));
 for(const relative of ['Conversaciones/memoria.md','CONVERSACIONES','Base/datos.json']){
  assert.throws(()=>validateManifest({...manifest,files:{...manifest.files,[relative]:'0'.repeat(64)}}),{code:'PRODUCT_MANIFEST_INVALID'});
 }
 assert.throws(()=>validateManifest({...manifest,links:{'Manual.md':'Conversaciones/memoria.md'}}),{code:'PRODUCT_MANIFEST_INVALID'});
 assert.throws(()=>validateManifest({...manifest,links:{'Conversaciones/enlace':'../Motor/app.js'}}),{code:'PRODUCT_MANIFEST_INVALID'});
});

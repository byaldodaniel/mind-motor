import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { copySemanticBundle } from '../src/semantic-bundle.js';
import { createSemanticEncoder } from '../src/semantic-encoder.js';
import { openMotor } from '../src/motor.js';

const source = fileURLToPath(new URL('../.cache/semantic/', import.meta.url));
test('modelo real offline trasladado: búsqueda no espera la carga, recuperación e integridad',
  {skip: !existsSync(path.join(source,'manifest.json'))}, async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'mind-semantic-runtime-'));
    let motor,encoder;
    t.after(async()=>{
      await motor?.closeConversationSearch();
      assert.equal(path.dirname(root),os.tmpdir());
      assert.ok(path.basename(root).startsWith('mind-semantic-runtime-'));
      await fs.rm(root,{recursive:true,force:true});
    });
    const config=JSON.parse(await fs.readFile(new URL('../packaging/semantica.json',import.meta.url),'utf8'));
    const directory=path.join(root,'Programa trasladado','semantica');
    await copySemanticBundle(directory,{source,manifestSha256:config.bundleManifestSha256});
    const base=path.join(root,'Base');await fs.mkdir(base);
    encoder=createSemanticEncoder({directory,idleMs:100});
    motor=await openMotor({baseDirectory:base,semanticEncoder:encoder});
    const item=await motor.saveConversation({title:'Cita ficticia',important:'La cita con el dentista será el jueves por la tarde.'});
    const initial=await motor.searchConversations({query:'¿Cuándo tengo la consulta odontológica?'});
    assert.equal(initial.semantic.status,'preparando');
    assert.equal((await motor.prepareConversationSearch()).error,null);
    const found=await motor.searchConversations({query:'¿Cuándo tengo la consulta odontológica?'});
    assert.equal(found.semantic.status,'activa');
    assert.equal(found.results[0].id,item.id);
    await new Promise(resolve=>setTimeout(resolve,180));
    assert.equal(encoder.isReady(),false);
    const start=performance.now();
    const waking=await motor.searchConversations({query:'¿Cuándo tengo la consulta odontológica?'});
    assert.ok(performance.now()-start<1000,'La consulta no debe esperar la recarga del modelo.');
    assert.equal(waking.semantic.status,'cargando');
    assert.equal((await motor.prepareConversationSearch()).error,null);
    assert.equal((await motor.searchConversations({query:'¿Cuándo tengo la consulta odontológica?'})).results[0].id,item.id);
    await motor.closeConversationSearch();
    // Alterar únicamente la copia de programa que pertenece a esta prueba.
    await fs.appendFile(path.join(directory,'ort.mjs'),'\n// alterado\n');
    const broken=createSemanticEncoder({directory});
    try { await assert.rejects(broken.embed(['ensayo']),{code:'SEMANTIC_FAILED'}); }
    finally { await broken.close(); }
  });

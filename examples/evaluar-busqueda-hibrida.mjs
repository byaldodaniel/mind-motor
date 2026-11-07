// Evaluación reproducible con modelo real, sin red y exclusivamente datos ficticios.
// node examples/evaluar-busqueda-hibrida.mjs [cantidad=1000]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openMotor } from '../src/motor.js';

const cases = [
  ['Archivos', 'Mantener los documentos en su ubicación original. No crear copias adicionales.', '¿Qué acordamos para evitar duplicados?', 'ubicación original'],
  ['Conservación', 'Guardar únicamente decisiones, correcciones, resultados y tareas pendientes.', '¿Qué información debemos recordar de cada charla?', 'decisiones correcciones'],
  ['Privacidad', 'Los datos del usuario se procesan en su equipo. No se envían a servidores externos.', '¿Sale información personal fuera del ordenador?', 'servidores externos'],
  ['Respaldo', 'Antes de publicar una versión nueva, conservar la anterior en un almacenamiento remoto verificado.', '¿Cómo recuperamos la edición previa si una actualización falla?', 'versión anterior'],
  ['Colores', 'La identidad visual utilizará azul oscuro y blanco. Evitar el rojo.', '¿Qué tonos elegimos para la marca?', 'azul blanco'],
  ['Agenda', 'La reunión del equipo será el próximo martes a las diez de la mañana.', '¿Cuándo nos juntamos a conversar con los compañeros?', 'martes diez'],
  ['Entrega', 'El pedido saldrá del almacén el viernes. Llegará al cliente el lunes.', '¿En qué fecha recibirá la compra el comprador?', 'pedido viernes'],
  ['Precio', 'La propuesta comercial cuesta 350 euros e incluye dos revisiones.', '¿Cuánto vale el presupuesto y cuántas correcciones cubre?', '350 euros'],
  ['Fotografías', 'Las imágenes generadas se guardarán en Multimedia; el resumen irá al Escritorio.', '¿Dónde ponemos las fotos creadas y la síntesis de la charla?', 'Multimedia Escritorio'],
  ['Sitio', 'La página de descarga debe mostrar siempre la edición estable más reciente.', '¿Qué debe aparecer en la web para quienes instalan el programa?', 'descarga estable'],
  ['Autorización', 'Borrar definitivamente un archivo requiere confirmación expresa del usuario.', '¿Necesitamos permiso antes de eliminar algo para siempre?', 'confirmación expresa'],
  ['Inventario', 'Se aprobaron 23 cajas para el primer envío de muestras.', '¿Cuántos paquetes autorizamos despachar inicialmente?', '23 cajas'],
  ['Continuación', 'Quedó pendiente confirmar la fecha con el proveedor. Ese será el siguiente paso.', '¿Qué tarea nos falta resolver para poder seguir?', 'confirmar proveedor'],
  ['Búsqueda', 'Combinar coincidencias textuales con similitud de significado para recuperar conversaciones.', '¿Cómo encontrar charlas usando otras palabras?', 'textuales significado'],
  ['Historial', 'El resumen vigente reemplaza los acuerdos obsoletos y conserva el motivo del cambio.', '¿Cómo evitamos continuar con decisiones que ya no están vigentes?', 'acuerdos obsoletos'],
  ['Portabilidad', 'Una conversación mantiene su identificador aunque se cambie de agente o se muevan sus recursos.', '¿Se pierde la continuidad si usamos otra aplicación?', 'identificador agente'],
  ['Pruebas', 'La validación utiliza exclusivamente registros inventados y una Base temporal separada.', '¿Con qué datos comprobamos los cambios sin tocar información real?', 'registros inventados'],
  ['Accesibilidad', 'Los botones tendrán etiquetas legibles y podrán activarse desde el teclado.', '¿Cómo podrá navegar alguien que no utiliza ratón?', 'botones teclado'],
  ['Pago', 'El cliente abonará la mitad al iniciar y el resto después de la entrega.', '¿En cuántas partes se cobra el trabajo?', 'mitad entrega'],
  ['Manual', 'El usuario prefiere que no se registre nada salvo que lo solicite explícitamente.', '¿Podemos guardar por nuestra cuenta o debemos esperar una petición?', 'solicite explícitamente'],
];
const exact = ['BRISA826','NUBE742','LOTE-93','POL-18','REF2026','ZXQ517'];
// Conjunto separado, fijado después de calibrar y antes de ejecutar: no se usa
// para cambiar modelo, umbral ni fragmentación. Contenido ficticio cotidiano.
const heldout = [
  ['Recuperación de cuenta','Si olvida su contraseña, solicite un enlace de restablecimiento por correo electrónico.','¿Cómo vuelvo a entrar si no recuerdo la clave de acceso?'],
  ['Plantas','Regar las macetas dos veces por semana y mantenerlas lejos del sol directo.','¿Con qué frecuencia debo echar agua a las plantas?'],
  ['Batería','Conectar el cargador cuando la batería baje del veinte por ciento.','¿Cuándo debería enchufar el dispositivo para recargarlo?'],
  ['Comida del encuentro','La cena del evento debe ofrecer un menú vegetariano sin carne ni pescado.','¿Qué comida serviremos a quienes no comen animales?'],
  ['Atención al cliente','El servicio de soporte atiende de lunes a viernes entre las nueve y las dieciocho horas.','¿En qué horario puedo contactar al equipo de ayuda?'],
  ['Traducción','Preparar la documentación en español e inglés para los dos grupos de lectores.','¿En qué idiomas necesitamos escribir las instrucciones?'],
  ['Imprenta','Imprimir el documento en papel A4 y orientación horizontal.','¿Qué tamaño de hoja y disposición usamos al imprimir?'],
  ['Viaje','El tren sale a las ocho desde la estación central. Llegar quince minutos antes.','¿A qué hora y desde dónde parte el ferrocarril?'],
  ['Video','La pieza audiovisual tendrá formato panorámico 16:9 y resolución de 1920 por 1080 píxeles.','¿Qué proporción y calidad tendrá la película que vamos a crear?'],
  ['Factura','Enviar al comprador la factura en PDF adjunta al correo después de confirmar el pago.','¿Cómo entregamos el comprobante de compra una vez abonado?'],
];
const negatives = ['¿Cuál es la temperatura de la superficie de Neptuno?', '¿Cómo se reproducen las medusas del Ártico?',
  '¿Qué estructura tiene el ADN de una mariposa?', '¿Cuántos volcanes activos hay en Venus?'];
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mind-hybrid-evaluation-'));
const count = Number(process.argv[2] ?? 1000);
assert.ok(Number.isInteger(count) && count >= 40 && count <= 5000);
const motor = await openMotor({ baseDirectory: base });
const beforeRss = process.memoryUsage().rss;
let peakRss = beforeRss;
const monitor = setInterval(() => peakRss = Math.max(peakRss, process.memoryUsage().rss), 25);
const timing = async task => { const start = performance.now(); const value = await task(); return { value, ms: performance.now() - start }; };
const stats = samples => {
  const sorted = [...samples].sort((a,b) => a-b);
  return { medianMs: Number(sorted[Math.floor(sorted.length/2)].toFixed(2)), p95Ms: Number(sorted[Math.ceil(sorted.length * .95)-1].toFixed(2)) };
};
try {
  const ids = [];
  for (const [title,important] of cases) ids.push((await motor.saveConversation({ title, important, project: 'Evaluación' })).id);
  const exactIds = [];
  for (const code of exact) exactIds.push((await motor.saveConversation({ title: 'Referencia ' + code, important: 'Identificador aprobado: ' + code })).id);
  const heldoutIds=[];
  for(const [title,important] of heldout) heldoutIds.push((await motor.saveConversation({title,important,project:'Validación independiente'})).id);
  const fillers = ['Se revisó la puntuación de un poema ficticio.', 'Se estudió el ritmo de una pieza musical.',
    'Se describieron las reglas de un juego de mesa.', 'Se compararon recetas de sopa de verduras.',
    'Se observaron plantas de un jardín experimental.', 'Se practicó vocabulario de un idioma inventado.'];
  for (let i=ids.length+exactIds.length+heldoutIds.length;i<count;i++) await motor.saveConversation({ title: 'Registro auxiliar ' + i,
    important: fillers[i % fillers.length] + ' Referencia auxiliar AUX' + i + '.' });
  const lexicalCold = await timing(() => motor.searchConversations({ query: cases[0][2], mode: 'palabras' }));
  const hybridCold = await timing(() => motor.searchConversations({ query: cases[0][2] }));
  const duringPreparation=[];
  for(let i=0;i<5;i++){
    const read=await timing(()=>motor.searchConversations({query:cases[i][3],mode:'palabras'}));
    duringPreparation.push(read.ms);
  }
  const prepared = await timing(() => motor.prepareConversationSearch());
  assert.equal(prepared.value.error, null);
  const readiness = await motor.searchConversations({query:cases[0][2]});
  assert.equal(readiness.semantic.status, 'activa', 'Se exige modelo real disponible; no se acepta fallback.');
  const observations = [];
  const lexicalTimes = [], hybridTimes = [];
  let lexicalHits = 0, hybridHits = 0, lexicalMrr = 0, hybridMrr = 0;
  for (let i=0;i<cases.length;i++) {
    const query=cases[i][2];
    const lexical = await timing(() => motor.searchConversations({ query, mode: 'palabras', limit: 3 }));
    const hybrid = await timing(() => motor.searchConversations({ query, limit: 3 }));
    assert.equal(hybrid.value.semantic.status, 'activa');
    assert.equal(hybrid.value.semantic.embedded, 0, 'No volver a vectorizar registros sin cambios.');
    assert.equal(hybrid.value.index.read, 0);
    const l=lexical.value.results.findIndex(x=>x.id===ids[i]), h=hybrid.value.results.findIndex(x=>x.id===ids[i]);
    if(l>=0){lexicalHits++;lexicalMrr+=1/(l+1);} if(h>=0){hybridHits++;hybridMrr+=1/(h+1);}
    lexicalTimes.push(lexical.ms);hybridTimes.push(hybrid.ms);
    observations.push({ query, expected: cases[i][0], lexicalRank: l<0?null:l+1, hybridRank: h<0?null:h+1,
      returnedTitles: hybrid.value.results.map(x=>x.title) });
  }
  let exactHits=0, keywordHits=0, negativeMatches=0;
  for(let i=0;i<exact.length;i++) {
    const result=await motor.searchConversations({query:exact[i]});
    if(result.results[0]?.id===exactIds[i])exactHits++;
  }
  for(let i=0;i<cases.length;i++) {
    const result=await motor.searchConversations({query:cases[i][3],limit:3});
    if(result.results.some(x=>x.id===ids[i]))keywordHits++;
  }
  const negativeResults=[];
  for(const query of negatives){const result=await motor.searchConversations({query});if(result.total)negativeMatches++;negativeResults.push({query,titles:result.results.map(x=>x.title)});}
  let heldoutLexicalHits=0,heldoutHybridHits=0;
  const heldoutObservations=[];
  for(let i=0;i<heldout.length;i++){
    const query=heldout[i][2];
    const lexical=await motor.searchConversations({query,mode:'palabras',limit:3});
    const hybrid=await motor.searchConversations({query,limit:3});
    const l=lexical.results.findIndex(x=>x.id===heldoutIds[i]),h=hybrid.results.findIndex(x=>x.id===heldoutIds[i]);
    if(l>=0)heldoutLexicalHits++;if(h>=0)heldoutHybridHits++;
    heldoutObservations.push({query,expected:heldout[i][0],lexicalRank:l<0?null:l+1,hybridRank:h<0?null:h+1,returnedTitles:hybrid.results.map(x=>x.title)});
  }
  // Cambio real: desaparece el código antiguo y se incorpora un dato situado al final de un resumen largo.
  await motor.saveConversation({ id: exactIds[0], expectedRevision: 1, title: 'Referencia vigente',
    important: 'Contexto auxiliar. '.repeat(150) + 'La cita con el dentista será el jueves por la tarde. Código vigente: SIERRA593.' });
  const updatePreparation = await timing(() => motor.prepareConversationSearch());
  const updated = await timing(() => motor.searchConversations({query:'SIERRA593'}));
  assert.equal(updated.value.results[0].id,exactIds[0]);

  const old=await motor.searchConversations({query:'BRISA826',mode:'palabras'});
  assert.equal(old.total,0);
  const tail=await motor.searchConversations({query:'¿Cuándo tengo la consulta odontológica?'});
  const tailFound = tail.results.slice(0,3).some(x=>x.id===exactIds[0]);
  const indexBytes=(await fs.stat(path.join(base,'conversation-index.sqlite'))).size;
  await motor.closeConversationSearch();
  await new Promise(resolve=>setTimeout(resolve,200));
  const report={count,model:hybridCold.value.semantic.model,scope:'Corpus sintético en español; motor y modelo locales reales; no mide respuesta del agente ni demuestra calidad en cualquier tema.',
    paraphrases:{queries:cases.length,lexicalRecallAt3:lexicalHits/cases.length,hybridRecallAt3:hybridHits/cases.length,
      lexicalMrrAt3:lexicalMrr/cases.length,hybridMrrAt3:hybridMrr/cases.length},
    exactIdentifiers:{queries:exact.length,top1:exactHits},keywordQueries:{queries:cases.length,recallAt3:keywordHits/cases.length},
    heldout:{queries:heldout.length,lexicalRecallAt3:heldoutLexicalHits/heldout.length,hybridRecallAt3:heldoutHybridHits/heldout.length,observations:heldoutObservations},
    calibrationTarget:{recallAt3:.85,met:hybridHits/cases.length>=.85},
    negatives:{queries:negatives.length,withMatches:negativeMatches,results:negativeResults},
    cold:{lexicalMs:lexicalCold.ms,hybridMs:hybridCold.ms,preparationMs:prepared.ms,firstState:hybridCold.value.semantic.status},
    warm:{lexical:stats(lexicalTimes),hybrid:stats(hybridTimes),duringPreparation:stats(duringPreparation),unchangedContentsRead:0,unchangedFragmentsEmbedded:0},
    update:{ms:updated.ms,preparationMs:updatePreparation.ms},
    memory:{beforeRssMiB:beforeRss/1024**2,peakRssMiB:peakRss/1024**2,afterUnloadRssMiB:process.memoryUsage().rss/1024**2},
    tail:{found:tailFound,results:tail.results.slice(0,3).map(x=>({title:x.title,excerpt:x.excerpt}))},indexBytes,observations};
  console.log(JSON.stringify(report,null,2));
  assert.ok(heldoutHybridHits/heldout.length >= .8,'Recuperar al menos 80% de consultas independientes entre los tres primeros.');
  assert.ok(hybridHits >= lexicalHits+6,'Mejorar la recuperación respecto a palabras.');
  assert.equal(exactHits,exact.length,'Conservar todos los códigos exactos en primer lugar.');
  assert.ok(negativeMatches<=1,'No devolver coincidencias para la mayoría de consultas ajenas.');
  assert.ok(stats(hybridTimes).p95Ms<1000,'Búsqueda caliente p95 inferior a un segundo en este equipo.');
  assert.ok(tailFound,'Recuperar el dato situado al final de un resumen largo.');
} finally {
  clearInterval(monitor);
  await motor.closeConversationSearch();
  assert.equal(path.dirname(base),os.tmpdir());
  assert.ok(path.basename(base).startsWith('mind-hybrid-evaluation-'));
  await fs.rm(base,{recursive:true,force:true});
}

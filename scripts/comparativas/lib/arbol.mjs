import fs from 'node:fs';
import path from 'node:path';
import { crearAzar } from './azar.mjs';

/**
 * Generador determinista de un árbol ficticio de documentos de una pequeña
 * empresa, con nombres en español: tildes, eñes, mayúsculas, guiones bajos,
 * fechas, archivos ocultos y una fracción de nombres en Unicode NFD (como los
 * que llegan copiados desde macOS). Todos los datos son ficticios.
 *
 * planificarArbol() no toca el disco: devuelve la verdad conocida (cada
 * entrada con su ruta, tipo, tamaño, fecha y forma canónica del nombre).
 * escribirArbol() la materializa. Los archivos que no son de texto se crean
 * dispersos (ftruncate): tienen el tamaño lógico previsto sin ocupar disco.
 */

export const PROFUNDIDAD_MAXIMA = 8;
const INICIO_FECHAS = Date.UTC(2023, 0, 1);
const FIN_FECHAS = Date.UTC(2026, 9, 15);

// Forma canónica explícita: minúsculas ASCII sin tildes. Es una implementación
// independiente del plegado de Mind (NFD + eliminación de marcas), de modo que
// la verdad no depende del código que se evalúa.
const SIN_TILDE = new Map(Object.entries({
  á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i',
  ó: 'o', ò: 'o', ö: 'o', ô: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c',
}));

/** Minúsculas ASCII sin tildes. Admite texto en NFC o NFD. */
export function canonico(texto) {
  let salida = '';
  for (const caracter of texto.normalize('NFC')) {
    const minuscula = caracter.toLowerCase();
    salida += SIN_TILDE.get(minuscula) ?? minuscula;
  }
  return salida;
}

/** Quita tildes pero conserva mayúsculas (usuario que escribe sin acentos). */
function sinTildes(texto) {
  let salida = '';
  for (const caracter of texto.normalize('NFC')) {
    const minuscula = caracter.toLowerCase();
    const base = SIN_TILDE.get(minuscula);
    salida += base === undefined ? caracter : (caracter === minuscula ? base : base.toUpperCase());
  }
  return salida;
}

const TEMAS_RAIZ = [
  'Proyectos', 'Clientes', 'Facturación', 'Contabilidad', 'Recursos Humanos', 'Documentación Técnica',
  'Fotografías', 'Correspondencia', 'Archivo Histórico', 'Investigación', 'Legal', 'Marketing y Comunicación',
];

const CLIENTES = [
  'Ñandú Logística', 'Cañaveral Óptica', 'Ibáñez Hermanos', 'Muñoz Arquitectura', 'Peñalver Diseño',
  'Construcciones Albéniz', 'Club Náutico Ría', 'Farmacia Núñez', 'Panadería Begoña', 'Transportes Gómez',
  'Viveros Ortúzar', 'Clínica Dental Sáez', 'Editorial Lúcida', 'Hostal Cañada', 'Talleres Úbeda',
  'Cooperativa Olivar', 'Imprenta Martín', 'Bodegas Peña Alta',
];
const PROYECTOS = [
  'Expansión Norte', 'Migración de Sistemas', 'Rediseño Web', 'Auditoría Interna', 'Plan Estratégico 2026',
  'Certificación ISO', 'App Móvil', 'Renovación Oficinas', 'Logística Sur', 'Formación Comercial',
  'Digitalización Archivo', 'Reducción de Costes', 'Nueva Sede Málaga', 'Atención Multicanal',
];
const PERSONAS = [
  'Lucía Martín', 'Óscar Núñez', 'Begoña Ibáñez', 'Íñigo Sáez', 'Ana Peña', 'José Muñoz',
  'María Gómez', 'Raúl Ortúzar', 'Elena Cañas', 'Tomás Albéniz', 'Sofía Herrán', 'Martín Lázaro',
];
const MESES = ['01 Enero', '02 Febrero', '03 Marzo', '04 Abril', '05 Mayo', '06 Junio', '07 Julio',
  '08 Agosto', '09 Septiembre', '10 Octubre', '11 Noviembre', '12 Diciembre'];
const ANIOS = ['2023', '2024', '2025', '2026'];
const GENERICAS = [
  'Borradores', 'Entregables', 'Revisión', 'Anexos', 'Antiguo', 'Copias de Seguridad', 'Presentaciones',
  'Reuniones', 'Actas', 'Contratos', 'Escaneos', 'Plantillas', 'Documentación', 'Imágenes', 'Datos',
  'Informes', 'Pendiente', 'Definitivo', 'Compartido', 'Varios', 'Seguimiento', 'Correcciones',
];
const OCULTAS = ['.borradores', '.copias', '.cache-visor', '.versiones', '.papelera-local'];

const SUBCARPETAS = {
  Proyectos: [PROYECTOS, [...GENERICAS, ...ANIOS, 'Fase 1', 'Fase 2', 'Fase 3', 'Diseño', 'Planificación']],
  Clientes: [CLIENTES, [...GENERICAS, ...ANIOS, 'Propuestas', 'Facturas', 'Incidencias']],
  'Facturación': [ANIOS, [...MESES, 'Emitidas', 'Recibidas', 'Rectificativas', 'Abonos']],
  Contabilidad: [ANIOS, ['1T', '2T', '3T', '4T', 'Balances', 'Impuestos', 'Bancos', 'Cierre Anual', ...GENERICAS]],
  'Recursos Humanos': [['Nóminas', 'Contratos', 'Formación', 'Evaluaciones', 'Selección', 'Vacaciones'], [...ANIOS, ...PERSONAS, ...GENERICAS]],
  'Documentación Técnica': [['Servidor Central', 'Red Interna', 'Aplicación Móvil', 'Base de Datos', 'Integración Contable', 'Copias'],
    ['v1.0', 'v1.2', 'v2.0', 'Manuales', 'Especificaciones', 'Registros', 'Configuración', ...GENERICAS]],
  'Fotografías': [ANIOS, ['Vacaciones Mallorca', 'Cumpleaños Lucía', 'Feria de Muestras', 'Inauguración Sede',
    'Navidad', 'Excursión Picos de Europa', 'Boda Óscar y Begoña', 'Equipo', 'Producto', 'Eventos', ...MESES]],
  Correspondencia: [['Recibida', 'Enviada', ...ANIOS], [...CLIENTES, ...ANIOS, ...GENERICAS]],
  'Archivo Histórico': [['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022'], [...GENERICAS, ...MESES]],
  'Investigación': [['Estudio de Mercado', 'Análisis de Competencia', 'Encuesta Satisfacción', 'Prototipos', 'Patentes'],
    ['Datos', 'Resultados', 'Bibliografía', ...ANIOS, ...GENERICAS]],
  Legal: [['Contratos', 'Escrituras', 'Licencias', 'Protección de Datos', 'Litigios'], [...CLIENTES, ...ANIOS, ...GENERICAS]],
  'Marketing y Comunicación': [['Campaña Primavera', 'Lanzamiento Producto', 'Feria Internacional', 'Logotipos', 'Redes Sociales', 'Prensa'],
    [...ANIOS, 'Imágenes', 'Textos', 'Vídeos', ...GENERICAS]],
};

const TIPOS = [
  'Informe', 'Información', 'Presupuesto', 'Acta de reunión', 'Factura', 'Contrato', 'Análisis',
  'Planificación', 'Diseño', 'Revisión', 'Nómina', 'Propuesta', 'Memoria', 'Resumen', 'Certificado',
  'Inventario', 'Calendario', 'Evaluación', 'Comunicación', 'Declaración', 'Especificación', 'Manual',
  'Balance', 'Previsión', 'Solicitud',
];
const TEMAS = [
  'Auditoría', 'Logística', 'Producción', 'Ventas', 'Atención al Cliente', 'Seguridad', 'Formación',
  'Mantenimiento', 'Expansión Norte', 'Ñandú Logística', 'Calidad', 'Compras', 'Tesorería', 'Marketing',
  'Personal', 'Innovación', 'Operaciones', 'Sostenibilidad',
];
const SUFIJOS = ['', '', '', '', ' v2', ' v3', ' final', ' FINAL', ' (copia)', ' definitivo', ' borrador', '_rev1'];

const EXTENSIONES = {
  documentos: [['pdf', 22], ['docx', 18], ['xlsx', 12], ['pptx', 4], ['odt', 2], ['md', 9], ['txt', 9],
    ['csv', 5], ['json', 2], ['png', 5], ['jpg', 6], ['zip', 2], ['eml', 2], ['log', 2]],
  'Facturación': [['pdf', 70], ['xlsx', 15], ['csv', 6], ['xml', 5], ['txt', 4]],
  'Fotografías': [['jpg', 52], ['JPG', 18], ['heic', 10], ['png', 12], ['mp4', 6], ['jpeg', 2]],
  'Documentación Técnica': [['md', 22], ['txt', 14], ['json', 12], ['log', 14], ['pdf', 14], ['docx', 10],
    ['xml', 4], ['png', 6], ['zip', 4]],
  'Investigación': [['csv', 20], ['xlsx', 16], ['pdf', 20], ['docx', 14], ['md', 10], ['txt', 8], ['png', 8], ['json', 4]],
  'Marketing y Comunicación': [['png', 22], ['jpg', 20], ['pptx', 12], ['pdf', 14], ['docx', 12], ['mp4', 8], ['md', 6], ['txt', 6]],
};
const TEXTO = new Set(['md', 'txt', 'csv', 'json', 'log', 'eml', 'xml']);
const TAMANOS = {
  pdf: [180_000, 1.3, 8_000, 25_000_000], docx: [60_000, 1.0, 9_000, 8_000_000],
  xlsx: [45_000, 1.1, 6_000, 12_000_000], pptx: [1_800_000, 1.0, 40_000, 80_000_000],
  odt: [40_000, 0.9, 8_000, 4_000_000], jpg: [2_400_000, 0.6, 60_000, 18_000_000],
  jpeg: [1_200_000, 0.6, 40_000, 9_000_000], JPG: [3_100_000, 0.5, 80_000, 20_000_000],
  heic: [1_600_000, 0.5, 200_000, 8_000_000], png: [350_000, 1.1, 4_000, 12_000_000],
  mp4: [45_000_000, 1.2, 1_000_000, 900_000_000], zip: [4_000_000, 1.6, 20_000, 700_000_000],
};

const FRASES = [
  'Se revisan los plazos acordados con el equipo.', 'Pendiente de confirmar con administración.',
  'Los importes se expresan en euros e incluyen IVA.', 'Documento ficticio generado para pruebas de Mind.',
  'La siguiente revisión está prevista para el próximo trimestre.', 'Se adjuntan los anexos correspondientes.',
  'El responsable informará del avance en la próxima reunión.', 'Sin incidencias relevantes en el periodo.',
  'Se acuerda mantener el procedimiento actual.', 'Hay que actualizar la documentación técnica.',
  'El cliente solicita una propuesta revisada.', 'La información se archivará al cierre del ejercicio.',
];

function fecha(milisegundos) {
  return new Date(milisegundos).toISOString().slice(0, 10);
}

function claveNombre(nombre) {
  // Únicos también en sistemas que no distinguen mayúsculas ni formas Unicode.
  return nombre.normalize('NFC').toLowerCase();
}

/** Contenido de texto determinista de un archivo; solo depende de la semilla y del índice. */
function contenidoTexto(semilla, indice, nombre, extension, mtimeMs) {
  const azar = crearAzar(`${semilla}:contenido:${indice}`);
  const lineas = [];
  const dia = fecha(mtimeMs);
  const persona = azar.elegir(PERSONAS);
  switch (extension) {
    case 'csv': {
      lineas.push('fecha;concepto;importe;responsable');
      for (let i = azar.entero(3, 40); i > 0; i -= 1) {
        lineas.push(`${dia};${azar.elegir(TEMAS)};${azar.entero(10, 99_999) / 100};${azar.elegir(PERSONAS)}`);
      }
      break;
    }
    case 'json':
      lineas.push(JSON.stringify({ documento: nombre, fecha: dia, responsable: persona,
        valores: Array.from({ length: azar.entero(1, 12) }, () => azar.entero(0, 10_000)) }, null, 2));
      break;
    case 'log':
      for (let i = azar.entero(4, 60); i > 0; i -= 1) {
        lineas.push(`${dia}T${String(azar.entero(0, 23)).padStart(2, '0')}:${String(azar.entero(0, 59)).padStart(2, '0')}:00Z `
          + `${azar.elegir(['INFO', 'INFO', 'INFO', 'AVISO', 'ERROR'])} ${azar.elegir(FRASES)}`);
      }
      break;
    case 'xml':
      lineas.push('<?xml version="1.0" encoding="UTF-8"?>', `<documento fecha="${dia}">`,
        `  <responsable>${persona}</responsable>`, `  <importe>${azar.entero(100, 99_999)}</importe>`, '</documento>');
      break;
    case 'eml':
      lineas.push(`From: ${canonico(persona).replace(/ /g, '.')}@empresa-ficticia.example`, `Date: ${dia}`,
        `Subject: ${nombre.replace(/\.eml$/u, '')}`, '');
      for (let i = azar.entero(1, 6); i > 0; i -= 1) lineas.push(azar.elegir(FRASES));
      break;
    default:
      lineas.push(`# ${nombre.replace(/\.[^.]+$/u, '')}`, '', `Fecha: ${dia}`, `Responsable: ${persona}`, '');
      for (let i = azar.entero(1, 14); i > 0; i -= 1) lineas.push(azar.elegir(FRASES));
  }
  return `${lineas.join('\n')}\n`;
}

/** Archivos plantados: tareas con respuesta conocida para los agentes. */
export const PLANTADOS = Object.freeze([
  {
    ruta: 'Clientes/Ñandú Logística/Reuniones/Acta de reunión 2025-03-14.md',
    mtime: Date.UTC(2025, 2, 14, 17, 5),
    contenido: '# Acta de reunión — Ñandú Logística\n\nFecha: 2025-03-14\nAsistentes: Lucía Martín, Óscar Núñez, Begoña Ibáñez\n\n'
      + '## Acuerdos\n\n1. Se aprueba ampliar la flota de reparto con tres furgonetas eléctricas.\n'
      + '   Responsable de la decisión: Íñigo Sáez.\n2. La siguiente revisión del contrato será en junio de 2025.\n',
  },
  {
    ruta: 'Clientes/Ñandú Logística/Reuniones/Acta de reunión 2025-02-11.md',
    mtime: Date.UTC(2025, 1, 11, 12, 40),
    contenido: '# Acta de reunión — Ñandú Logística\n\nFecha: 2025-02-11\n\n## Acuerdos\n\n'
      + '1. Se pospone la renovación del almacén.\n   Responsable de la decisión: Ana Peña.\n',
  },
  {
    ruta: 'Clientes/Cañaveral Óptica/Reuniones/Acta de reunión 2025-03-14.md',
    mtime: Date.UTC(2025, 2, 14, 10, 15),
    contenido: '# Acta de reunión — Cañaveral Óptica\n\nFecha: 2025-03-14\n\n## Acuerdos\n\n'
      + '1. Se renuevan los escaparates de la tienda principal.\n   Responsable de la decisión: José Muñoz.\n',
  },
  {
    ruta: 'Proyectos/Expansión Norte/Actas/ACTA DE REUNIÓN 2025-03-14 borrador.docx',
    mtime: Date.UTC(2025, 2, 14, 19, 0),
    bytes: 48_213,
  },
]);

/**
 * Planifica un árbol con exactamente `entradas` entradas (archivos + carpetas,
 * sin contar la raíz), como las cuenta el índice de Mind.
 * @param {{ entradas: number, semilla?: string, fraccionCarpetas?: number }} opciones
 */
export function planificarArbol({ entradas: total, semilla = 'mind-comparativas-1', fraccionCarpetas = 0.06 }) {
  if (!Number.isSafeInteger(total) || total < 200) throw new Error('El árbol necesita al menos 200 entradas.');
  const azar = crearAzar(`${semilla}:${total}`);
  const carpetas = [];
  const porRuta = new Map();
  const entradas = [];

  function nuevaCarpeta(padre, nombre, extra = {}) {
    const ruta = padre ? `${padre.ruta}/${nombre}` : nombre;
    const carpeta = {
      ruta, nombre, profundidad: padre ? padre.profundidad + 1 : 1, padre,
      tema: padre ? padre.tema : nombre, hijos: new Set(), peso: 1, anio: null, cliente: null, oculta: false, ...extra,
    };
    if (/^(20\d\d)$/u.test(nombre)) carpeta.anio = Number(nombre);
    else if (padre) carpeta.anio = padre.anio;
    carpeta.cliente = CLIENTES.includes(nombre) ? nombre : padre?.cliente ?? null;
    carpeta.oculta = nombre.startsWith('.') || Boolean(padre?.oculta);
    padre?.hijos.add(claveNombre(nombre));
    carpetas.push(carpeta);
    porRuta.set(ruta, carpeta);
    entradas.push({
      ruta, tipo: 'carpeta', bytes: null, mtimeMs: INICIO_FECHAS + Math.floor(azar.siguiente() * (FIN_FECHAS - INICIO_FECHAS)),
      canonica: canonico(nombre), oculta: carpeta.oculta, nfd: false,
    });
    return carpeta;
  }

  function asegurarCarpeta(ruta) {
    if (porRuta.has(ruta)) return porRuta.get(ruta);
    const corte = ruta.lastIndexOf('/');
    const padre = corte < 0 ? null : asegurarCarpeta(ruta.slice(0, corte));
    return nuevaCarpeta(padre, ruta.slice(corte + 1));
  }

  // Pocas entradas sueltas en la raíz de cada tema: la mayoría está en subcarpetas.
  for (const nombre of TEMAS_RAIZ) nuevaCarpeta(null, nombre).peso = 0.4;
  for (const plantado of PLANTADOS) asegurarCarpeta(plantado.ruta.slice(0, plantado.ruta.lastIndexOf('/')));

  // Carpetas: el padre se elige al azar con preferencia por las menos profundas.
  const objetivoCarpetas = Math.max(carpetas.length + 1, Math.round(total * fraccionCarpetas));
  while (carpetas.length < objetivoCarpetas) {
    let padre;
    for (;;) {
      padre = azar.elegir(carpetas);
      // Las carpetas ocultas no tienen subcarpetas: solo archivos.
      if (!padre.oculta && padre.profundidad < PROFUNDIDAD_MAXIMA && azar.si(0.62 ** (padre.profundidad - 1))) break;
    }
    let nombre = null;
    if (azar.si(0.004)) {
      nombre = azar.elegir(OCULTAS);
    } else {
      const [primeras, siguientes] = SUBCARPETAS[padre.tema];
      const preferidas = padre.profundidad === 1 ? primeras : siguientes;
      // Si las preferidas están ocupadas, se usa una genérica antes de numerar.
      for (let intento = 0; intento < 8 && nombre === null; intento += 1) {
        const opcion = azar.elegir(intento < 5 ? preferidas : GENERICAS);
        if (!padre.hijos.has(claveNombre(opcion))) nombre = opcion;
      }
      nombre ??= azar.elegir(preferidas);
    }
    let candidato = nombre;
    for (let n = 2; padre.hijos.has(claveNombre(candidato)); n += 1) candidato = `${nombre} ${n}`;
    const carpeta = nuevaCarpeta(padre, candidato);
    // Log-normal: muchas carpetas con pocos archivos y unas pocas muy pobladas.
    carpeta.peso = Math.exp(0.9 * azar.normal()) * (padre.tema === 'Fotografías' && carpeta.profundidad >= 3 ? 5 : 1);
  }

  // Archivos: cada carpeta recibe archivos en proporción a su peso.
  const acumulado = [];
  let suma = 0;
  for (const carpeta of carpetas) {
    suma += carpeta.peso;
    acumulado.push(suma);
  }
  function carpetaAlAzar() {
    const objetivo = azar.siguiente() * suma;
    let bajo = 0;
    let alto = acumulado.length - 1;
    while (bajo < alto) {
      const medio = (bajo + alto) >> 1;
      if (acumulado[medio] > objetivo) alto = medio;
      else bajo = medio + 1;
    }
    return carpetas[bajo];
  }

  function fechaArchivo(carpeta) {
    if (carpeta.anio && azar.si(0.7)) {
      const inicio = Date.UTC(carpeta.anio, 0, 1);
      const fin = Math.min(Date.UTC(carpeta.anio + 1, 0, 1), FIN_FECHAS);
      if (fin > inicio) return inicio + Math.floor(azar.siguiente() * (fin - inicio));
    }
    if (carpeta.tema === 'Archivo Histórico') {
      return Date.UTC(2015, 0, 1) + Math.floor(azar.siguiente() * (Date.UTC(2023, 0, 1) - Date.UTC(2015, 0, 1)));
    }
    return INICIO_FECHAS + Math.floor(azar.siguiente() * (FIN_FECHAS - INICIO_FECHAS));
  }

  function nombreDocumento(carpeta, extension, mtimeMs) {
    const tipo = carpeta.tema === 'Facturación' ? azar.elegir(['Factura', 'Factura', 'Factura', 'Resumen', 'Previsión'])
      : azar.elegir(TIPOS);
    const tema = carpeta.cliente && azar.si(0.5) ? carpeta.cliente : azar.elegir(TEMAS);
    const dia = fecha(mtimeMs);
    const sufijo = azar.elegir(SUFIJOS);
    const forma = azar.ponderado([['titulo', 40], ['guiones', 20], ['mayusculas', 10], ['sinTildes', 15], ['fechaPrimero', 15]]);
    switch (forma) {
      case 'guiones': return `${canonico(`${tipo} ${tema}`).replace(/ /gu, '_')}_${dia}${sufijo.replace(/ /gu, '_')}.${extension}`;
      case 'mayusculas': return `${tipo.toUpperCase()} ${tema.toUpperCase()}${sufijo}.${extension}`;
      case 'sinTildes': return `${sinTildes(tipo)} ${sinTildes(tema)} ${dia}${sufijo}.${extension}`;
      case 'fechaPrimero': return `${dia} ${tipo} ${tema}${sufijo}.${extension}`;
      default: return `${tipo} ${tema} ${dia}${sufijo}.${extension}`;
    }
  }

  function nombreFactura(carpeta, extension, mtimeMs) {
    const anio = new Date(mtimeMs).getUTCFullYear();
    const numero = String(azar.entero(1, 9999)).padStart(4, '0');
    const cliente = carpeta.cliente ?? azar.elegir(CLIENTES);
    return azar.ponderado([
      [`Factura F-${anio}-${numero} ${cliente}.${extension}`, 45],
      [`factura_${numero}_${canonico(cliente).replace(/ /gu, '_')}.${extension}`, 20],
      [`FACTURA ${numero} ${cliente.toUpperCase()}.${extension}`, 10],
      [`Recibo ${fecha(mtimeMs)} ${cliente}.${extension}`, 15],
      [`Abono A-${anio}-${numero}.${extension}`, 10],
    ]);
  }

  function nombreFoto(carpeta, extension, mtimeMs) {
    const momento = new Date(mtimeMs).toISOString();
    const hora = `${momento.slice(11, 13)}.${momento.slice(14, 16)}.${momento.slice(17, 19)}`;
    return azar.ponderado([
      [`IMG_${String(azar.entero(0, 9999)).padStart(4, '0')}.${extension}`, 40],
      [`DSC0${String(azar.entero(0, 9999)).padStart(4, '0')}.${extension}`, 20],
      [`${carpeta.nombre} (${azar.entero(1, 400)}).${extension}`, 20],
      [`Captura de pantalla ${fecha(mtimeMs)} a las ${hora}.${extension}`, 10],
      [`WhatsApp Image ${fecha(mtimeMs)} at ${hora}.${extension}`, 10],
    ]);
  }

  const plantados = new Map(PLANTADOS.map((item) => [item.ruta, item]));
  let indiceArchivo = 0;

  function nuevoArchivo(carpeta, nombre, extension, mtimeMs, fijo = null) {
    let candidato = nombre;
    const punto = nombre.lastIndexOf('.');
    for (let n = 2; carpeta.hijos.has(claveNombre(candidato)); n += 1) {
      candidato = punto > 0 ? `${nombre.slice(0, punto)} (${n})${nombre.slice(punto)}` : `${nombre} (${n})`;
    }
    const oculta = carpeta.oculta || candidato.startsWith('.');
    // Una fracción de los nombres con tildes llega en NFD, como al copiar desde macOS.
    const nfd = fijo === null && /[^\u0000-\u007f]/u.test(candidato) && azar.si(0.06);
    const enDisco = nfd ? candidato.normalize('NFD') : candidato;
    carpeta.hijos.add(claveNombre(candidato));
    const indice = indiceArchivo++;
    let contenido = null;
    let bytes;
    if (fijo?.contenido !== undefined) {
      contenido = fijo.contenido;
    } else if (fijo?.bytes !== undefined) {
      bytes = fijo.bytes;
    } else if (TEXTO.has(extension)) {
      contenido = contenidoTexto(semilla, indice, candidato, extension, mtimeMs);
    } else {
      const [mediana, sigma, minimo, maximo] = TAMANOS[extension] ?? TAMANOS.pdf;
      bytes = azar.lognormal(mediana, sigma, minimo, maximo);
    }
    if (contenido !== null) bytes = Buffer.byteLength(contenido, 'utf8');
    entradas.push({
      ruta: `${carpeta.ruta}/${enDisco}`, tipo: 'archivo', bytes, mtimeMs, canonica: canonico(candidato),
      oculta, nfd, ...(contenido !== null ? { contenido } : {}), ...(fijo ? { plantado: true } : {}),
    });
  }

  for (const [ruta, plantado] of plantados) {
    const corte = ruta.lastIndexOf('/');
    const nombre = ruta.slice(corte + 1);
    nuevoArchivo(porRuta.get(ruta.slice(0, corte)), nombre, nombre.slice(nombre.lastIndexOf('.') + 1), plantado.mtime, plantado);
  }

  while (entradas.length < total) {
    const carpeta = carpetaAlAzar();
    const extension = azar.ponderado(EXTENSIONES[carpeta.tema] ?? EXTENSIONES.documentos);
    const mtimeMs = fechaArchivo(carpeta);
    let nombre;
    if (carpeta.tema === 'Fotografías' && ['jpg', 'JPG', 'heic', 'png', 'mp4', 'jpeg'].includes(extension)) {
      nombre = nombreFoto(carpeta, extension, mtimeMs);
    } else if (carpeta.tema === 'Facturación' && azar.si(0.75)) {
      nombre = nombreFactura(carpeta, extension, mtimeMs);
    } else {
      nombre = nombreDocumento(carpeta, extension, mtimeMs);
    }
    if (azar.si(0.008)) nombre = azar.si(0.5) ? `.~lock.${nombre}#` : `.${nombre}`;
    nuevoArchivo(carpeta, nombre, extension, mtimeMs);
  }

  const archivos = entradas.filter((entrada) => entrada.tipo === 'archivo');
  const profundidades = entradas.map((entrada) => entrada.ruta.split('/').length);
  return {
    semilla,
    total: entradas.length,
    carpetas: entradas.length - archivos.length,
    archivos: archivos.length,
    profundidadMaxima: Math.max(...profundidades),
    profundidadMedia: Number((profundidades.reduce((a, b) => a + b, 0) / profundidades.length).toFixed(2)),
    ocultas: entradas.filter((entrada) => entrada.oculta).length,
    nfd: archivos.filter((entrada) => entrada.nfd).length,
    conTildes: archivos.filter((entrada) => /[^\u0000-\u007f]/u.test(entrada.ruta.slice(entrada.ruta.lastIndexOf('/') + 1))).length,
    bytesLogicos: archivos.reduce((suma, entrada) => suma + entrada.bytes, 0),
    entradas,
  };
}

/**
 * Escribe el plan bajo `raiz` (debe existir y estar vacía).
 * @returns {{ segundos: number }}
 */
export function escribirArbol(raiz, plan) {
  const inicio = performance.now();
  for (const entrada of plan.entradas) {
    const destino = path.join(raiz, ...entrada.ruta.split('/'));
    if (entrada.tipo === 'carpeta') {
      fs.mkdirSync(destino);
      continue;
    }
    if (entrada.contenido !== undefined) {
      fs.writeFileSync(destino, entrada.contenido, { flag: 'wx' });
    } else {
      const descriptor = fs.openSync(destino, 'wx');
      try {
        fs.ftruncateSync(descriptor, entrada.bytes);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    const momento = new Date(entrada.mtimeMs);
    fs.utimesSync(destino, momento, momento);
  }
  // Las fechas de las carpetas, al final y de dentro hacia fuera.
  for (let i = plan.entradas.length - 1; i >= 0; i -= 1) {
    const entrada = plan.entradas[i];
    if (entrada.tipo !== 'carpeta') continue;
    const momento = new Date(entrada.mtimeMs);
    fs.utimesSync(path.join(raiz, ...entrada.ruta.split('/')), momento, momento);
  }
  return { segundos: (performance.now() - inicio) / 1000 };
}

function nombreDe(ruta) {
  return ruta.slice(ruta.lastIndexOf('/') + 1);
}

/**
 * Verdad conocida de una búsqueda: archivos (o también carpetas) cuyo nombre,
 * en forma canónica, contiene la consulta en forma canónica, con los filtros
 * de metadatos indicados.
 */
export function verdad(plan, { consulta = '', extensiones = null, desde = null, hasta = null, minBytes = null, maxBytes = null,
  tipos = ['archivo'], dentroDe = null } = {}) {
  const aguja = canonico(consulta);
  const exts = extensiones ? new Set(extensiones.map((item) => canonico(item.replace(/^\./u, '')))) : null;
  const resultado = new Set();
  for (const entrada of plan.entradas) {
    if (!tipos.includes(entrada.tipo)) continue;
    if (dentroDe !== null && !entrada.ruta.startsWith(`${dentroDe}/`)) continue;
    if (!entrada.canonica.includes(aguja)) continue;
    if (exts) {
      const nombre = entrada.canonica;
      const punto = nombre.lastIndexOf('.');
      if (punto <= 0 || !exts.has(nombre.slice(punto + 1))) continue;
    }
    if (minBytes !== null && !(entrada.bytes >= minBytes)) continue;
    if (maxBytes !== null && !(entrada.bytes <= maxBytes)) continue;
    if (desde !== null && entrada.mtimeMs < desde) continue;
    if (hasta !== null && entrada.mtimeMs >= hasta) continue;
    resultado.add(entrada.ruta);
  }
  return resultado;
}

export { nombreDe };

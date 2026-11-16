#!/usr/bin/env node
// Medición repetible de puertas de rendimiento y exactitud para Mind 1.0.4-r3.
// Opera únicamente sobre un directorio temporal aislado en os.tmpdir() y lee en modo
// solo lectura los índices reales y fichas de proyectos para generar la línea base o comparar.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMotor } from '../src/motor.js';
import { openSession } from '../src/session.js';
import { createIndexStore } from '../src/index-store.js';

const MOTOR_DIR = fileURLToPath(new URL('..', import.meta.url));
const REAL_BASE = 'C:\\Users\\Aldo Daniel\\Desktop\\My Mind\\Sistema\\Base';
const PORTABLE_PYTHON = 'C:\\Users\\Aldo Daniel\\Desktop\\My Mind\\Sistema\\Componentes\\Python\\win32-x64\\python.exe';
const EVIDENCE_FILE = path.join(MOTOR_DIR, 'docs', 'evidencia', 'medicion-r3.json');

const REAL_PROJECT_FILES = [
  'G:\\Mi unidad\\Aldo Daniel\\Proyecto.md',
  'G:\\Mi unidad\\Aldo Daniel\\Mind\\Proyecto.md',
  'G:\\.shortcut-targets-by-id\\1BvHUdDD2RsyNYzVegxwOl1PYXJtNNrcq\\Cafe Tostado\\ASPROCOAN\\Proyecto.md',
  'D:\\SACTEK\\Proyecto.md',
  'D:\\KEEP PACKING\\Proyecto.md',
];

function msSince(t0) {
  return Number((performance.now() - t0).toFixed(2));
}

function getProcessMemoryMb(pid = process.pid) {
  const mem = process.memoryUsage();
  let privateMb = null;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PrivateMemorySize64`], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
      privateMb = Number((Number(out.trim()) / 1048576).toFixed(1));
    } catch {}
  }
  return {
    rssMb: Number((mem.rss / 1048576).toFixed(1)),
    heapUsedMb: Number((mem.heapUsed / 1048576).toFixed(1)),
    privateMb,
  };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function measure() {
  const pythonExecutable = (await exists(PORTABLE_PYTHON)) ? PORTABLE_PYTHON : (process.env.MIND_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'));
  const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mind-medir-r3-')));
  const tempBase = path.join(tmpRoot, 'Base');
  const tempProject = path.join(tmpRoot, 'ProyectoPrueba');
  const tempSynthetic = path.join(tmpRoot, 'Sintetico');
  const startWall = performance.now();

  const report = {
    fecha: new Date().toISOString(),
    rama: (() => {
      try { return execFileSync('git', ['-C', MOTOR_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
    })(),
    commit: (() => {
      try { return execFileSync('git', ['-C', MOTOR_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
    })(),
    baseRealCopiada: false,
    entradasCopiadasReales: 0,
    busquedaReal: null,
    arbol100k: null,
    reconciliacionCambioUnArchivo: null,
    marcasYAgrupacion: null,
    memoriaProceso: null,
    duracionTotalMs: null,
  };

  try {
    await fs.mkdir(tempBase, { recursive: true, mode: 0o700 });
    await fs.mkdir(tempProject, { recursive: true });
    await fs.mkdir(tempSynthetic, { recursive: true });

    // 1. Copiar en solo lectura los índices reales existentes (si están) y medir búsqueda fría/caliente.
    if (await exists(REAL_BASE)) {
      const files = await fs.readdir(REAL_BASE);
      const auths = [];
      let copiedIndexes = 0;
      for (const name of files) {
        if (name === 'mind-base.json' || /^folder-(?:index|authorization|properties)-[a-f0-9]{64}\.json$/.test(name)) {
          await fs.copyFile(path.join(REAL_BASE, name), path.join(tempBase, name));
          if (name.startsWith('folder-index-')) copiedIndexes++;
          if (name.startsWith('folder-authorization-')) auths.push(name);
        }
      }
      report.baseRealCopiada = copiedIndexes > 0;
      if (copiedIndexes > 0) {
        // Leer directamente mediante createIndexStore / openMotor sobre la copia aislada (sin disparar scans sobre discos externos).
        const store = createIndexStore(tempBase);
        const scopeIds = [];
        for (const name of files) {
          const m = /^folder-index-([a-f0-9]{64})\.json$/.exec(name);
          if (m) scopeIds.push(m[1]);
        }
        const tCold = performance.now();
        let totalEntries = 0;
        let matchesCold = 0;
        for (const id of scopeIds) {
          const idx = await store.load(id);
          if (idx) {
            totalEntries += idx.entries.length;
            for (const e of idx.entries) if (e.path.toLowerCase().includes('proyecto')) matchesCold++;
          }
        }
        const coldMs = msSince(tCold);
        const tWarm = performance.now();
        let matchesWarm = 0;
        for (const id of scopeIds) {
          const idx = await store.load(id);
          if (idx) {
            for (const e of idx.entries) if (e.path.toLowerCase().includes('proyecto')) matchesWarm++;
          }
        }
        const warmMs = msSince(tWarm);
        report.entradasCopiadasReales = totalEntries;
        report.busquedaReal = {
          carpetas: scopeIds.length,
          entradas: totalEntries,
          coincidencias: matchesWarm,
          frioMs: coldMs,
          calienteMs: warmMs,
          igual: matchesCold === matchesWarm,
        };
      }
    }

    // 2. Medir indexación / almacenamiento de 100.000 entradas sintéticas en el store vigente.
    const synthScope = 'a'.repeat(64);
    const synthEntries = [];
    for (let i = 0; i < 100_000; i++) {
      const dir = `rama-${Math.floor(i / 1000).toString().padStart(3, '0')}`;
      synthEntries.push({
        path: `${dir}/archivo-${String(i).padStart(6, '0')}.md`,
        type: 'file',
        size: 512,
        modifiedAt: '2026-11-15T12:00:00.000Z',
        changedAt: '2026-11-15T12:00:00.000Z',
        createdAt: '2026-11-15T12:00:00.000Z',
        identity: `nt:1:${1000 + i}`,
        state: 'indexed',
        reason: null,
      });
    }
    synthEntries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const store100k = createIndexStore(tempBase);
    const tWrite100k = performance.now();
    await store100k.save({
      scopeId: synthScope,
      root: tempSynthetic,
      authorizationGeneration: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      createdAt: '2026-11-15T12:00:00.000Z',
      updatedAt: '2026-11-15T12:00:00.000Z',
      entries: synthEntries,
      issues: [],
    });
    const write100kMs = msSince(tWrite100k);
    store100k.clearCache();
    const tRead100kCold = performance.now();
    const loaded100k = await store100k.load(synthScope);
    const read100kColdMs = msSince(tRead100kCold);
    const tRead100kWarm = performance.now();
    await store100k.load(synthScope);
    const read100kWarmMs = msSince(tRead100kWarm);
    report.arbol100k = {
      entradas: loaded100k?.entries?.length ?? 0,
      escrituraMs: write100kMs,
      lecturaFriaMs: read100kColdMs,
      lecturaCalienteMs: read100kWarmMs,
    };

    // 3. Medir reconciliación de 1 archivo modificado dentro de una carpeta de prueba real (1.500 archivos en 30 ramas).
    const testBase2 = path.join(tmpRoot, 'Base2');
    await fs.mkdir(testBase2, { recursive: true, mode: 0o700 });
    const branches = 20;
    const perBranch = 50;
    await Promise.all(Array.from({ length: branches }, async (_, b) => {
      const dir = path.join(tempProject, `grupo-${String(b).padStart(2, '0')}`);
      await fs.mkdir(dir, { recursive: true });
      await Promise.all(Array.from({ length: perBranch }, (__, f) =>
        fs.writeFile(path.join(dir, `doc-${f}.md`), `# Doc ${b}-${f}\n- #pendiente Tarea ${b}.${f}\n`)
      ));
    }));
    const layout = {
      product: false,
      root: null,
      motorDirectory: MOTOR_DIR,
      baseDirectory: testBase2,
      pythonExecutable,
      protectedDirectories: [],
      userDataDirectory: null,
    };
    const session = await openSession({ layout, motorVersion: '1.0.4-r3-bench', observe: false });
    try {
      const auth = await session.motor.authorizeFolder(tempProject);
      await session.policy.set(auth.id, { encontrar: true, leer: true, escribir: true, organizar: true }, { channel: 'administracion-local' });
      const tInitialScan = performance.now();
      const first = await session.motor.indexFolder(auth.id);
      const initialScanMs = msSince(tInitialScan);

      await fs.writeFile(path.join(tempProject, 'grupo-05', 'doc-10.md'), '# Doc 5-10 actualizado\n- #pendiente Nueva tarea\n');
      const tOneFile = performance.now();
      const second = await session.motor.indexFolder(auth.id, { hints: { paths: ['grupo-05/doc-10.md'], overflow: false } });
      const reconcileOneMs = msSince(tOneFile);

      const tSearch = performance.now();
      const searchRes = await session.motor.searchFiles({ folderIds: [auth.id], query: 'doc-10' });
      const searchMs = msSince(tSearch);

      report.reconciliacionCambioUnArchivo = {
        entradas: first.totals.entries,
        indexacionInicialMs: initialScanMs,
        reconciliacionUnArchivoMs: reconcileOneMs,
        busquedaMs: searchMs,
        coincidencias: searchRes.total,
        generacion: second.generation,
      };

      // 4. Medir extracción y agrupación de marcas si groupMarks está disponible en el Motor (Etapa 3).
      const realProjectsPresent = [];
      let manualPendientes = 0;
      let manualIdeas = 0;
      const projectBenchDir = path.join(tmpRoot, 'ProyectosReales');
      await fs.mkdir(projectBenchDir, { recursive: true });
      for (const file of REAL_PROJECT_FILES) {
        if (await exists(file)) {
          const content = await fs.readFile(file, 'utf8');
          const label = path.basename(path.dirname(file));
          const sub = path.join(projectBenchDir, label);
          await fs.mkdir(sub, { recursive: true });
          await fs.writeFile(path.join(sub, 'Proyecto.md'), content);
          realProjectsPresent.push(label);
          for (const line of content.split(/\r?\n/)) {
            if (/#pendiente\b/i.test(line)) manualPendientes++;
            if (/#idea\b/i.test(line)) manualIdeas++;
          }
        }
      }
      if (typeof session.motor.groupMarks === 'function') {
        const authProj = await session.motor.authorizeFolder(projectBenchDir);
        await session.policy.set(authProj.id, { encontrar: true, leer: true, escribir: false, organizar: false }, { channel: 'administracion-local' });
        await session.motor.indexFolder(authProj.id);
        const tGroup = performance.now();
        const groupedPend = await session.motor.groupMarks({ folderIds: [authProj.id], tag: 'pendiente', status: 'abierto', groupBy: 'proyecto' });
        const groupMs = msSince(tGroup);
        report.marcasYAgrupacion = {
          disponible: true,
          proyectosAnalizados: realProjectsPresent,
          conteoManualLinea: { pendientes: manualPendientes, ideas: manualIdeas },
          agrupadoMs: groupMs,
          totalPendientesDetectados: groupedPend.total,
          grupos: groupedPend.grupos.map((g) => ({ grupo: g.grupo, total: g.total, abiertos: g.abiertos })),
        };
      } else {
        report.marcasYAgrupacion = {
          disponible: false,
          proyectosAnalizados: realProjectsPresent,
          conteoManualLinea: { pendientes: manualPendientes, ideas: manualIdeas },
        };
      }
    } finally {
      await session.close();
    }
  } finally {
    report.memoriaProceso = getProcessMemoryMb();
    report.duracionTotalMs = msSince(startWall);
    await fs.mkdir(path.dirname(EVIDENCE_FILE), { recursive: true });
    await fs.writeFile(EVIDENCE_FILE, `${JSON.stringify(report, null, 2)}\n`);
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }

  console.log(JSON.stringify(report, null, 2));
}

measure().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

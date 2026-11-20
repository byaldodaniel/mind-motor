// Sustituto de prueba de src/sqlite-catalog.js: mismas exportaciones, con un
// gancho antes de cada publicación del índice. Solo lo cargan los procesos de
// prueba que registran el redireccionamiento; el Motor no incluye hooks.
import * as real from '../../src/sqlite-catalog.js';

export * from '../../src/sqlite-catalog.js';

const hooked = (name) => async (...args) => {
  await globalThis.__mindCatalogPublish?.(name, ...args);
  return real[name](...args);
};

export const saveScopeIndexToCatalog = hooked('saveScopeIndexToCatalog');
export const saveScopeBranchToCatalog = hooked('saveScopeBranchToCatalog');

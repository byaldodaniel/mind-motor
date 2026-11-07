import path from 'node:path';
import { readJson, writeJson } from './storage.js';
import { MotorError } from './errors.js';
import { withIndexLock } from './index-lock.js';
import { requestSignal } from './request-context.js';

export const PREFERENCES_FILE = 'conversation-preferences.json';
export const RETENTION_MODES = ['esencial', 'detallado', 'manual', 'personalizado'];
export const DEFAULT_RETENTION = Object.freeze({ mode: 'esencial', rules: '' });
const GUIDANCE = {
  esencial: 'Conserva decisiones y motivos, correcciones vigentes, resultados y ubicaciones, pendientes y siguiente paso. Actualiza ante cambios relevantes o al completar una etapa; no por cada mensaje.',
  detallado: 'Conserva además contexto de trabajo, alternativas consideradas y explicaciones útiles. No supone copiar el historial completo. Actualiza ante cambios relevantes o al completar una etapa.',
  manual: 'Guarda únicamente cuando el usuario lo indique expresamente. No guardes automáticamente.',
  personalizado: 'Sigue las reglas del usuario para elegir contenido y momento de guardado.',
};
export function retention(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !['mode','rules','directory'].includes(k))
      || !RETENTION_MODES.includes(value.mode) || typeof value.rules !== 'string'
      || !value.rules.isWellFormed() || value.rules.includes('\0') || Buffer.byteLength(value.rules) > 4096
      || (value.mode === 'personalizado' && !value.rules.trim())) {
    throw new MotorError('INVALID_CONVERSATION_PREFERENCES', 'Indica modo válido y reglas de hasta 4096 bytes; personalizado requiere reglas.');
  }
  if (value.directory !== undefined && (typeof value.directory !== 'string' || !path.isAbsolute(value.directory) || value.directory.includes('\0') || value.directory.length > 4096)) throw new MotorError('INVALID_CONVERSATION_PREFERENCES','carpeta_destino debe ser una ruta absoluta.');
  return { mode: value.mode, rules: value.rules, ...(value.directory === undefined ? {} : {directory:value.directory}) };
}
export const describeRetention = value => ({ ...value, automatic: value.mode !== 'manual',
  guidance: GUIDANCE[value.mode], maxContentBytes: 64 * 1024 });

export function createConversationPreferences(baseDirectory) {
  const filename = path.join(baseDirectory, PREFERENCES_FILE);
  const lock = task => withIndexLock(baseDirectory, 'all', task, 'conversation-preferences', { signal: requestSignal() });
  async function read() {
    const stored = await readJson(filename);
    if (!stored) return { revision: 0, preferences: { ...DEFAULT_RETENTION } };
    const data = stored.data;
    if (data?.format !== 'mind-conversation-preferences' || data.version !== 1
        || !Number.isSafeInteger(data.revision) || data.revision < 1) {
      throw new MotorError('INVALID_CONVERSATION_PREFERENCES', 'Preferencias de conversación no compatibles.');
    }
    return { revision: data.revision, preferences: retention(data.preferences) };
  }
  async function write(preferences, expectedRevision) {
    const normalized = retention(preferences);
    return lock(async () => {
      const before = await read();
      if (expectedRevision !== before.revision) throw new MotorError('CONVERSATION_PREFERENCES_CONFLICT', 'Las preferencias cambiaron; vuelve a consultarlas.');
      const next = { revision: before.revision + 1, preferences: normalized };
      await writeJson(filename, { format: 'mind-conversation-preferences', version: 1, ...next });
      return next;
    });
  }
  async function relocate(map) {
    return lock(async()=>{
      const previous=await read(),directory=previous.preferences.directory;
      if(directory===undefined || map(directory)===directory)return;
      await writeJson(filename,{format:'mind-conversation-preferences',version:1,revision:previous.revision+1,
        preferences:{...previous.preferences,directory:map(directory)}});
    });
  }
  return { read, write, lock, relocate };
}

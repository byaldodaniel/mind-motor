import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { get } from 'node:http';
import { MotorError } from './errors.js';

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const PROOF = /^[0-9a-f]{64}$/;

function readResponse(port, id, authorization) {
  return new Promise((resolve, reject) => {
    const request = get({
      hostname: '127.0.0.1', port, path: '/interno/continuidad/' + id,
      headers: { Authorization: authorization }, agent: false,
      signal: AbortSignal.timeout(5_000),
    }, async response => {
      try {
        const proof = response.headers['x-mind-continuity-proof'];
        if (!PROOF.test(proof ?? '')) throw new Error('Respuesta interna sin firma válida.');
        const chunks = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > MAX_RECORD_BYTES) throw new Error('Respuesta interna demasiado grande.');
          chunks.push(chunk);
        }
        resolve({ status: response.statusCode, proof, bytes: Buffer.concat(chunks, length) });
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

// El anfitrión y el Motor reciben la misma clave interna al arrancar.
// La clave y la lectura de registros en bruto quedan fuera del protocolo MCP.
export function createNativeContinuityReader({ port, key, baseId }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !PROOF.test(key ?? '')) {
    throw new TypeError('La lectura nativa de continuidad requiere un puerto y una clave interna válidos.');
  }
  const sign = (context, value) => createHmac('sha256', key).update(baseId + '\n').update(context).update(value).digest();
  const unavailable = cause => new MotorError('CONTINUITY_READER_UNAVAILABLE',
    'No se pudo leer el registro con el anfitrión nativo.', { cause });
  return async id => {
    const nonce = randomBytes(16).toString('hex');
    const requestProof = sign('read\n' + nonce + '\n', id).toString('hex');
    const { status, proof, bytes } = await readResponse(port, id, 'Mind-Internal ' + nonce + '.' + requestProof)
      .catch(error => { throw unavailable(error); });
    const expected = sign('record\n' + nonce + '\n' + status + '\n', bytes);
    if (!timingSafeEqual(Buffer.from(proof, 'hex'), expected)) {
      throw unavailable();
    }
    if (status === 404) return null;
    if (status === 409) throw new MotorError('RECORD_LINK', 'Un registro técnico no puede ser un enlace.');
    if (status === 422) throw new MotorError('RECORD_CORRUPT', 'El registro técnico supera el tamaño admitido.');
    if (status !== 200) throw unavailable();
    return bytes.toString('utf8');
  };
}

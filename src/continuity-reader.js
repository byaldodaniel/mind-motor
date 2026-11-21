import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { MotorError } from './errors.js';

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const PROOF = /^[0-9a-f]{64}$/;

function exchange(port, path, authorization, { method = 'GET', body, digest, waitForWrite = false } = {}) {
  return new Promise((resolve, reject) => {
    const connection = request({
      hostname: '127.0.0.1', port, path: '/interno/continuidad/' + path, method,
      headers: { Authorization: authorization,
        ...(body === undefined ? {} : { 'Content-Length': body.length, 'X-Mind-Write-Digest': digest }),
      }, agent: false,
      signal: waitForWrite ? undefined : AbortSignal.timeout(5_000),
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
    connection.on('error', reject);
    connection.end(body);
  });
}

// El anfitrión y el Motor reciben la misma clave interna al arrancar.
// La clave y la lectura de registros en bruto quedan fuera del protocolo MCP.
export function createNativeContinuityStore({ port, key, baseId }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !PROOF.test(key ?? '')) {
    throw new TypeError('La continuidad nativa requiere un puerto y una clave interna válidos.');
  }
  const sign = (context, value) => createHmac('sha256', key).update(baseId + '\n').update(context).update(value).digest();
  const unavailable = cause => new MotorError('CONTINUITY_READER_UNAVAILABLE',
    'No se pudo leer el registro con el anfitrión nativo.', { cause });
  async function call(path, action, nonce, signed, options) {
    const requestProof = sign(action + '\n' + nonce + '\n', signed).toString('hex');
    const { status, proof, bytes } = await exchange(port, path, 'Mind-Internal ' + nonce + '.' + requestProof, options);
    const expected = sign('record\n' + nonce + '\n' + status + '\n', bytes);
    if (!timingSafeEqual(Buffer.from(proof, 'hex'), expected)) throw new Error('Firma interna inválida.');
    return { status, bytes };
  }

  async function readContinuityText(id) {
    const nonce = randomBytes(16).toString('hex');
    const { status, bytes } = await call(id, 'read', nonce, id).catch(error => { throw unavailable(error); });
    if (status === 404) return null;
    if (status === 409) throw new MotorError('RECORD_LINK', 'Un registro técnico no puede ser un enlace.');
    if (status === 422) throw new MotorError('RECORD_CORRUPT', 'El registro técnico supera el tamaño admitido.');
    if (status !== 200) throw unavailable();
    return bytes.toString('utf8');
  }

  async function writeNativeText({ root, relativePath, bytes, expected, maxBytes, confirm }) {
    const nonce = randomBytes(16).toString('hex');
    const body = Buffer.from(JSON.stringify({ root, relativePath, content: bytes.toString('base64'), expected, maxBytes }));
    const digest = createHash('sha256').update(body).digest('hex');
    async function send(action, options) {
      let reply, value;
      try {
        reply = await call(action, action, nonce, options?.digest ?? '', { method: 'POST', waitForWrite: action === 'confirmar', ...options });
        value = JSON.parse(reply.bytes);
      } catch (cause) {
        const code = action === 'confirmar' ? 'WRITE_UNCONFIRMED' : 'WRITE_UNAVAILABLE';
        throw new MotorError(code, 'No se pudo confirmar la escritura con el anfitrión nativo.', { cause });
      }
      if (reply.status !== 200) {
        throw new MotorError(value?.error ?? 'WRITE_FAILED', 'El anfitrión nativo rechazó la escritura.');
      }
      return value;
    }
    if ((await send('escribir', { body, digest })).ready !== true) {
      throw new MotorError('WRITE_FAILED', 'No se pudo preparar la escritura con el anfitrión nativo.');
    }
    // El anfitrión ya abrió el destino de forma segura. Revalida antes de publicar.
    try { await confirm(); }
    catch (error) {
      await send('cancelar').catch(() => {});
      throw error;
    }
    const report = await send('confirmar');
    if (report.size !== bytes.length) {
      throw new MotorError('WRITE_UNCONFIRMED', 'No se pudo confirmar qué se escribió.');
    }
    return report;
  }

  return { readContinuityText, writeNativeText };
}

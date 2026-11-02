import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LANZADOR = fileURLToPath(new URL('../../../bin/mind.js', import.meta.url));

/**
 * Cliente MCP mínimo por stdio (JSON-RPC, un mensaje por línea) para medir
 * Mind tal como lo ve un agente: inicia `mind mcp --base <Base>`, que abre su
 * propia sesión, y llama a las herramientas. No acepta formularios de
 * consentimiento: las autorizaciones se conceden antes, como usuario.
 */
export function iniciarMcp({ base, env = {}, clientInfo = { name: 'comparativas-mind', version: '1.0' } }) {
  const hijo = spawn(process.execPath, [LANZADOR, 'mcp', '--base', base], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const esperando = new Map();
  let siguiente = 1;
  let pendiente = '';
  let errores = '';
  const terminado = new Promise((resolver) => hijo.on('exit', (code, signal) => resolver({ code, signal })));
  hijo.stderr.on('data', (trozo) => { if (errores.length < 20_000) errores += trozo; });
  hijo.stdout.setEncoding('utf8');
  hijo.stdout.on('data', (trozo) => {
    pendiente += trozo;
    let salto;
    while ((salto = pendiente.indexOf('\n')) >= 0) {
      const linea = pendiente.slice(0, salto);
      pendiente = pendiente.slice(salto + 1);
      if (!linea.trim()) continue;
      const mensaje = JSON.parse(linea);
      if (mensaje.method && Object.hasOwn(mensaje, 'id')) {
        // Petición del servidor (p. ej., elicitación): se rechaza; nadie responde por el usuario.
        hijo.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mensaje.id, error: { code: -32601, message: 'no' } })}\n`);
        continue;
      }
      const resolver = esperando.get(mensaje.id);
      if (resolver) {
        esperando.delete(mensaje.id);
        resolver({ mensaje, bytes: Buffer.byteLength(linea, 'utf8') });
      }
    }
  });

  function peticion(method, params = {}) {
    const id = siguiente++;
    return new Promise((resolver) => {
      esperando.set(id, resolver);
      hijo.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  return {
    hijo,
    terminado,
    errores: () => errores,
    async inicializar() {
      const { mensaje } = await peticion('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo });
      hijo.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return mensaje.result;
    },
    /** Llama a una herramienta; devuelve datos estructurados, error y bytes de la respuesta. */
    async llamar(nombre, argumentos = {}) {
      const inicio = performance.now();
      const { mensaje, bytes } = await peticion('tools/call', { name: nombre, arguments: argumentos });
      const milisegundos = performance.now() - inicio;
      if (mensaje.error) return { error: mensaje.error, milisegundos, bytes };
      const { structuredContent, isError = false } = mensaje.result;
      return {
        datos: structuredContent, esError: isError, milisegundos, bytes,
        bytesEstructurados: Buffer.byteLength(JSON.stringify(structuredContent), 'utf8'),
      };
    },
    async cerrar() {
      hijo.stdin.end();
      const salida = await Promise.race([terminado, new Promise((resolver) => setTimeout(() => resolver(null), 15_000))]);
      if (salida === null) {
        hijo.kill('SIGKILL');
        return terminado;
      }
      return salida;
    },
  };
}

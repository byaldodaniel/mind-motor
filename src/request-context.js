import { AsyncLocalStorage } from 'node:async_hooks';
import { MotorError } from './errors.js';

const requests = new AsyncLocalStorage();
const cancelled = () => new MotorError('REQUEST_CANCELLED', 'La solicitud se canceló.');

/** Request-scoped cancellation without adding agent-controlled arguments to tools. */
export function withRequestContext(context, task) {
  const state = { signal: context?.signal, active: true };
  return requests.run(state, async () => {
    try { return await task(); }
    finally { state.active = false; }
  });
}

export function requestSignal() {
  const state = requests.getStore();
  return state?.active ? state.signal : undefined;
}

/** Cancel only a caller's wait, never the shared background work it is observing. */
export function waitForRequest(promise, signal = requestSignal()) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
    // Attach handlers even when already cancelled: shared work can reject later.
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

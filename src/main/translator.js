// Proveedor de traducción (Google Translate, endpoint público con detección
// automática). Aislado aquí para poder sustituirlo por DeepL u otro.

let netFetch = globalThis.fetch;
try {
  // Pila de red de Chromium: respeta el proxy del sistema y reutiliza
  // conexiones HTTP/2 (menos latencia que el fetch de Node).
  // eslint-disable-next-line global-require
  const { net } = require('electron');
  if (net && net.fetch) netFetch = net.fetch.bind(net);
} catch { /* fuera de Electron (tests) */ }

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const cache = new Map();
const MAX_CACHE = 500;

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

async function request(text, target, source, signal) {
  const url = `${ENDPOINT}?client=gtx&dt=t&sl=${encodeURIComponent(source)}`
    + `&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
  const timeout = AbortSignal.timeout(6000);
  const res = await netFetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) {
    const err = new Error(res.status === 429 ? 'demasiadas solicitudes, espera un momento' : `el traductor respondió ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const translated = (Array.isArray(data[0]) ? data[0] : []).map((s) => (s && s[0]) || '').join('');
  return { translated, detected: typeof data[2] === 'string' ? data[2] : source };
}

// ---- Protección contra "demasiadas solicitudes" -------------------------
// 1) Espaciado mínimo entre peticiones (todas las ventanas juntas).
// 2) Peticiones idénticas simultáneas se agrupan en una sola.
// 3) Ante un 429 se hace una pausa global creciente (10 s → 2 min) sin
//    enviar nada; durante la pausa se responde al instante con un error.
const MIN_SPACING = 180; // ms entre peticiones → máx. ~5/s
const COOLDOWN_MIN = 10_000;
const COOLDOWN_MAX = 120_000;
const inflight = new Map();
let nextSlot = 0;
let cooldownUntil = 0;
let cooldownMs = 0;

function cooldownRemaining() { return Math.max(0, cooldownUntil - Date.now()); }

function cooldownError() {
  const secs = Math.ceil(cooldownRemaining() / 1000);
  const err = new Error(`límite del traductor alcanzado; se reanuda solo en ${secs} s`);
  err.code = 'COOLDOWN';
  err.retryIn = cooldownRemaining();
  return err;
}

async function slot(signal) {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_SPACING;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  if (signal && signal.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}

async function fetchWithRetry(text, target, source, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (cooldownRemaining()) throw cooldownError();
    try {
      await slot(signal);
      const out = await request(text, target, source, signal);
      cooldownMs = 0; // funcionó: se olvida la penalización
      return out;
    } catch (err) {
      lastErr = err;
      if (signal && signal.aborted) throw err;
      if (err.status === 429) {
        // Nunca insistir ante un 429: pausa global y creciente
        cooldownMs = Math.min(COOLDOWN_MAX, cooldownMs ? cooldownMs * 2 : COOLDOWN_MIN);
        cooldownUntil = Date.now() + cooldownMs;
        throw cooldownError();
      }
      if (err.status && err.status < 500) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 + attempt * 600));
    }
  }
  if (lastErr && lastErr.name === 'TimeoutError') throw new Error('el traductor no responde (¿sin internet?)');
  if (lastErr && /fetch|network|ERR_/i.test(lastErr.message)) throw new Error('sin conexión con el traductor');
  throw lastErr;
}

/** Traduce con caché LRU, agrupación de peticiones, espaciado y pausa ante 429. */
async function translate(text, target, source = 'auto', signal) {
  const key = `${source}\u0001${target}\u0001${text}`;
  const hit = cache.get(key);
  if (hit) { remember(key, hit); return hit; }
  if (cooldownRemaining()) throw cooldownError();

  let p = inflight.get(key);
  if (!p) {
    // La petición compartida no se cancela si un recuadro deja de esperarla
    p = fetchWithRetry(text, target, source).then((out) => { remember(key, out); return out; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Solo para pruebas. */
function _reset() { cache.clear(); inflight.clear(); nextSlot = 0; cooldownUntil = 0; cooldownMs = 0; }

module.exports = {
  translate, cooldownRemaining, ENDPOINT, _reset,
};

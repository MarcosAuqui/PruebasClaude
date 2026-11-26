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

/** Traduce con caché LRU y un reintento ante fallos de red transitorios. */
async function translate(text, target, source = 'auto', signal) {
  const key = `${source}\u0001${target}\u0001${text}`;
  const hit = cache.get(key);
  if (hit) { remember(key, hit); return hit; }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await request(text, target, source, signal);
      remember(key, out);
      return out;
    } catch (err) {
      lastErr = err;
      if (signal && signal.aborted) throw err;
      if (err.status && err.status !== 429 && err.status < 500) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 + attempt * 400));
    }
  }
  if (lastErr && lastErr.name === 'TimeoutError') throw new Error('el traductor no responde (¿sin internet?)');
  if (lastErr && /fetch|network|ERR_/i.test(lastErr.message)) throw new Error('sin conexión con el traductor');
  throw lastErr;
}

module.exports = { translate, ENDPOINT };

// Traductores disponibles:
// - google-free: endpoint público de Google (sin clave, límite por conexión)
// - deepl: API de DeepL con clave propia (Free: 500.000 caracteres/mes)
// - google-cloud: Google Cloud Translation v2 con clave propia
// - microsoft: Microsoft Translator con clave propia (2 M caracteres/mes gratis)
// - mymemory: API pública de MyMemory, sin clave (cuota diaria pequeña)
// Modo gratuito = Google gratuito y, si Google lo bloquea, MyMemory.
// Si el proveedor con clave falla (clave inválida, cuota agotada, idioma no
// soportado) y el respaldo está activo, se usa el modo gratuito.

const { guessLanguage } = require('./langguess');

let netFetch = globalThis.fetch;
try {
  // Pila de red de Chromium: respeta el proxy del sistema y reutiliza conexiones
  // eslint-disable-next-line global-require
  const { net } = require('electron');
  if (net && net.fetch) netFetch = net.fetch.bind(net);
} catch { /* fuera de Electron (tests) */ }

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const TIMEOUT = 8000;

// ---------------------------------------------------------------- config

const state = {
  provider: 'google-free',
  fallback: true,
  keys: { deepl: '', 'google-cloud': '', microsoft: '' },
  msRegion: '',
  onNotice: () => {},
};

function configure({
  provider, fallback, keys, msRegion, onNotice,
} = {}) {
  if (provider) state.provider = provider;
  if (typeof msRegion === 'string') state.msRegion = msRegion;
  if (typeof fallback === 'boolean') state.fallback = fallback;
  if (keys) state.keys = { ...state.keys, ...keys };
  if (onNotice) state.onNotice = onNotice;
}

function activeProvider() {
  const p = state.provider;
  if (p !== 'google-free' && !state.keys[p]) return 'google-free';
  return p;
}

// ---------------------------------------------------------------- errores

function fail(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

async function readError(res) {
  try {
    const body = await res.json();
    return (body && (body.message || (body.error && body.error.message))) || '';
  } catch { return ''; }
}

function signalWith(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ---------------------------------------------------------------- proveedores

const googleFree = {
  name: 'Google gratuito',
  spacing: 180,
  supports: () => true,
  async translate(text, target, source, signal) {
    const url = `${ENDPOINT}?client=gtx&dt=t&sl=${encodeURIComponent(source)}`
      + `&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
    const res = await netFetch(url, { signal: signalWith(signal) });
    if (res.status === 429) {
      // Página «Sorry…»: Google bloquea su servicio gratuito para esta conexión
      let body = '';
      try { body = await res.text(); } catch { /* nada */ }
      const blocked = /sorry|unusual traffic|tráfico inusual/i.test(body);
      throw fail(blocked ? 'Google está bloqueando su servicio gratuito' : 'demasiadas solicitudes a Google', { status: 429, blocked });
    }
    if (!res.ok) throw fail(`Google respondió ${res.status}`, { status: res.status });
    const data = await res.json();
    const translated = (Array.isArray(data[0]) ? data[0] : []).map((s) => (s && s[0]) || '').join('');
    return { translated, detected: typeof data[2] === 'string' ? data[2] : source };
  },
};

// Códigos de DeepL (destino). Los que faltan no los admite DeepL.
const DEEPL_TARGET = {
  en: 'EN-US', es: 'ES', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT-BR', nl: 'NL', pl: 'PL',
  tr: 'TR', sv: 'SV', ru: 'RU', uk: 'UK', el: 'EL', ar: 'AR', id: 'ID', ja: 'JA', ko: 'KO',
  'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT',
};
const DEEPL_SOURCE = {
  en: 'EN', es: 'ES', fr: 'FR', de: 'DE', it: 'IT', pt: 'PT', nl: 'NL', pl: 'PL', tr: 'TR',
  sv: 'SV', ru: 'RU', uk: 'UK', el: 'EL', ar: 'AR', id: 'ID', ja: 'JA', ko: 'KO', 'zh-CN': 'ZH', 'zh-TW': 'ZH',
};
const fromDeepL = (c) => {
  const l = String(c || '').toLowerCase();
  return l === 'zh' ? 'zh-CN' : l;
};

const deepl = {
  name: 'DeepL',
  spacing: 60,
  supports: (target, source) => !!DEEPL_TARGET[target] && (source === 'auto' || !!DEEPL_SOURCE[source]),
  async translate(text, target, source, signal, key = state.keys.deepl) {
    // Las claves gratuitas terminan en ":fx" y usan otro servidor
    const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const body = { text: [text], target_lang: DEEPL_TARGET[target] };
    if (source !== 'auto') body.source_lang = DEEPL_SOURCE[source];
    const res = await netFetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signalWith(signal),
    });
    if (res.status === 403) throw fail('la clave de DeepL no es válida', { status: 403, auth: true });
    if (res.status === 456) throw fail('se agotó la cuota mensual de DeepL', { status: 456, quota: true });
    if (res.status === 429) throw fail('demasiadas solicitudes a DeepL', { status: 429 });
    if (!res.ok) {
      const msg = await readError(res);
      throw fail(`DeepL respondió ${res.status}${msg ? `: ${msg}` : ''}`, { status: res.status });
    }
    const data = await res.json();
    const t = data.translations && data.translations[0];
    if (!t) throw fail('respuesta vacía de DeepL');
    return { translated: t.text, detected: fromDeepL(t.detected_source_language) || source };
  },
};

function decodeEntities(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const googleCloud = {
  name: 'Google Cloud',
  spacing: 30,
  supports: () => true,
  async translate(text, target, source, signal, key = state.keys['google-cloud']) {
    const body = { q: [text], target, format: 'text' };
    if (source !== 'auto') body.source = source;
    const res = await netFetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key.trim())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signalWith(signal),
    });
    if (!res.ok) {
      const msg = await readError(res);
      if (res.status === 429) throw fail('demasiadas solicitudes a Google Cloud', { status: 429 });
      if (/api key not valid|API_KEY_INVALID/i.test(msg)) throw fail('la clave de Google Cloud no es válida', { status: res.status, auth: true });
      if (res.status === 403) {
        throw fail(`Google Cloud rechazó la clave (¿API de traducción sin activar o sin facturación?)${msg ? `: ${msg}` : ''}`, { status: 403, auth: true });
      }
      throw fail(`Google Cloud respondió ${res.status}${msg ? `: ${msg}` : ''}`, { status: res.status });
    }
    const data = await res.json();
    const t = data.data && data.data.translations && data.data.translations[0];
    if (!t) throw fail('respuesta vacía de Google Cloud');
    return { translated: decodeEntities(t.translatedText), detected: t.detectedSourceLanguage || source };
  },
};

// MyMemory: API pública (uso anónimo permitido). Necesita el idioma de
// origen, que se detecta localmente. Límite de 500 bytes por petición.
const base = (c) => String(c || '').slice(0, 2).toLowerCase();

function splitForLimit(text, max = 450) {
  if (Buffer.byteLength(text) <= max) return [text];
  const parts = [];
  let cur = '';
  for (const piece of text.split(/(?<=[.!?。！？])\s*/u)) {
    const next = cur ? `${cur} ${piece}` : piece;
    if (Buffer.byteLength(next) <= max) { cur = next; continue; }
    if (cur) parts.push(cur);
    // Frase demasiado larga: se corta por palabras
    let chunk = '';
    for (const w of piece.split(/\s+/)) {
      const n = chunk ? `${chunk} ${w}` : w;
      if (Buffer.byteLength(n) > max && chunk) { parts.push(chunk); chunk = w; } else chunk = n;
    }
    cur = chunk;
  }
  if (cur) parts.push(cur);
  return parts;
}

const myMemory = {
  name: 'MyMemory',
  spacing: 350,
  supports: () => true,
  async translate(text, target, source, signal) {
    const src = source === 'auto' ? guessLanguage(text) : source;
    if (base(src) === base(target) && src !== 'zh-TW' && target !== 'zh-TW') return { translated: text, detected: src };
    const out = [];
    for (const piece of splitForLimit(text)) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(piece)}`
        + `&langpair=${encodeURIComponent(src)}|${encodeURIComponent(target)}`;
      const res = await netFetch(url, { signal: signalWith(signal) });
      if (res.status === 429) throw fail('se agotó la cuota diaria gratuita de MyMemory', { status: 429, daily: true });
      if (!res.ok) throw fail(`MyMemory respondió ${res.status}`, { status: res.status });
      const data = await res.json();
      const st = Number(data.responseStatus);
      const t = (data.responseData && data.responseData.translatedText) || '';
      if (st === 429 || data.quotaFinished || /MYMEMORY WARNING/i.test(t)) {
        throw fail('se agotó la cuota diaria gratuita de MyMemory', { status: 429, daily: true });
      }
      if (st !== 200) throw fail(`MyMemory: ${data.responseDetails || st}`, { status: st >= 400 && st < 500 ? st : 500 });
      out.push(decodeEntities(t));
    }
    return { translated: out.join(' '), detected: src };
  },
};

// Microsoft Translator (Azure). Región: la del recurso (vacía si es global).
const msCode = (c) => ({ 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' }[c] || c);
const fromMs = (c) => ({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' }[c] || c);

const microsoft = {
  name: 'Microsoft',
  spacing: 40,
  supports: () => true,
  async translate(text, target, source, signal, key = state.keys.microsoft, region = state.msRegion) {
    let url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(msCode(target))}`;
    if (source !== 'auto') url += `&from=${encodeURIComponent(msCode(source))}`;
    const headers = { 'Ocp-Apim-Subscription-Key': key.trim(), 'Content-Type': 'application/json' };
    if (region && region.trim()) headers['Ocp-Apim-Subscription-Region'] = region.trim();
    const res = await netFetch(url, {
      method: 'POST', headers, body: JSON.stringify([{ Text: text }]), signal: signalWith(signal),
    });
    if (!res.ok) {
      const msg = await readError(res);
      if (res.status === 401) {
        throw fail(`la clave de Microsoft no es válida o no coincide con la región${msg ? ` (${msg})` : ''}`, { status: 401, auth: true });
      }
      if (res.status === 403) throw fail(`Microsoft: cuota agotada o recurso no permitido${msg ? ` (${msg})` : ''}`, { status: 403, quota: true });
      if (res.status === 429) throw fail('demasiadas solicitudes a Microsoft', { status: 429 });
      throw fail(`Microsoft respondió ${res.status}${msg ? `: ${msg}` : ''}`, { status: res.status });
    }
    const data = await res.json();
    const item = Array.isArray(data) && data[0];
    const t = item && item.translations && item.translations[0];
    if (!t) throw fail('respuesta vacía de Microsoft');
    return { translated: t.text, detected: fromMs((item.detectedLanguage && item.detectedLanguage.language) || source) };
  },
};

const PROVIDERS = {
  'google-free': googleFree, mymemory: myMemory, deepl, microsoft, 'google-cloud': googleCloud,
};
const FREE_CHAIN = ['google-free', 'mymemory'];

// ---------------------------------------------------------------- caché

const cache = new Map();
const MAX_CACHE = 500;
function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

// ---- Protección contra "demasiadas solicitudes" (por proveedor) -----------
// 1) Espaciado mínimo entre peticiones (todas las ventanas juntas).
// 2) Peticiones idénticas simultáneas se agrupan en una sola.
// 3) Ante un 429 se hace una pausa creciente (10 s → 2 min) sin reintentos.
const COOLDOWN_MIN = 10_000;
const COOLDOWN_MAX = 120_000;
const inflight = new Map();
const limits = {}; // proveedor → { nextSlot, until, ms }
const lim = (p) => (limits[p] ||= { nextSlot: 0, until: 0, ms: 0 });

function cooldownRemaining(p = activeProvider()) { return Math.max(0, lim(p).until - Date.now()); }

function humanWait(ms) {
  const secs = Math.ceil(ms / 1000);
  return secs > 90 ? `${Math.ceil(secs / 60)} min` : `${secs} s`;
}

function cooldownError(p) {
  const wait = humanWait(cooldownRemaining(p));
  return fail(`${PROVIDERS[p].name} pidió esperar por exceso de solicitudes; se reanuda solo en ${wait}`, {
    code: 'COOLDOWN', retryIn: cooldownRemaining(p),
  });
}

async function slot(p) {
  const l = lim(p);
  const now = Date.now();
  const wait = Math.max(0, l.nextSlot - now);
  l.nextSlot = Math.max(now, l.nextSlot) + PROVIDERS[p].spacing;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function callProvider(p, text, target, source) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (cooldownRemaining(p)) throw cooldownError(p);
    try {
      await slot(p);
      const out = await PROVIDERS[p].translate(text, target, source);
      lim(p).ms = 0; // funcionó: se olvida la penalización
      return { ...out, provider: PROVIDERS[p].name };
    } catch (err) {
      lastErr = err;
      if (err.status === 429) {
        const l = lim(p);
        if (err.blocked) l.until = Date.now() + 30 * 60_000; // bloqueo de Google: no insistir en 30 min
        else if (err.daily) l.until = Date.now() + 60 * 60_000; // cuota diaria agotada
        else {
          l.ms = Math.min(COOLDOWN_MAX, l.ms ? l.ms * 2 : COOLDOWN_MIN);
          l.until = Date.now() + l.ms;
        }
        const e = cooldownError(p);
        e.cause = err;
        throw e;
      }
      if (err.status && err.status < 500) throw err; // clave, cuota, petición: no reintentar
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 + attempt * 600));
    }
  }
  if (lastErr && lastErr.name === 'TimeoutError') throw fail('el traductor no responde (¿sin internet?)');
  if (lastErr && /fetch|network|ERR_/i.test(lastErr.message)) throw fail('sin conexión con el traductor');
  throw lastErr;
}

const noticed = new Set();
function noticeOnce(key, text) {
  if (noticed.has(key)) return;
  noticed.add(key);
  state.onNotice(text);
}

/**
 * Modo gratuito: Google y, si Google bloquea o pide esperar, MyMemory.
 * Si todos están limitados, se informa cuándo se reintenta y qué hacer.
 */
async function runFree(text, target, source) {
  let lastErr = null;
  for (const p of FREE_CHAIN) {
    if (cooldownRemaining(p)) { lastErr = cooldownError(p); continue; }
    try {
      const out = await callProvider(p, text, target, source);
      if (p !== FREE_CHAIN[0]) {
        noticeOnce('free:fallback', 'Google está limitando su traductor gratuito, así que se usa MyMemory (unos 5.000 caracteres al día). Para traducir sin cortes, añade una clave gratis de Microsoft o DeepL en Ajustes → Traductor.');
      }
      return out;
    } catch (err) {
      lastErr = err;
      // Errores de la petición (4xx que no sean límites) no mejoran con otro servicio
      if (err.status && err.status < 500 && err.status !== 429 && err.code !== 'COOLDOWN') throw err;
    }
  }
  const waits = FREE_CHAIN.map((p) => cooldownRemaining(p)).filter(Boolean);
  if (waits.length === FREE_CHAIN.length) {
    const retryIn = Math.min(...waits);
    throw fail(`los traductores gratuitos están limitando las solicitudes (se reintenta en ${humanWait(retryIn)}). Con una clave gratis de Microsoft o DeepL (Ajustes → Traductor) no dependes de ellos`, {
      code: 'COOLDOWN', retryIn,
    });
  }
  throw lastErr;
}

/** Elige proveedor y aplica el respaldo al modo gratuito cuando corresponde. */
async function run(text, target, source) {
  const p = activeProvider();
  if (p === 'google-free') return runFree(text, target, source);
  if (!PROVIDERS[p].supports(target, source)) {
    if (!state.fallback) throw fail(`${PROVIDERS[p].name} no admite este idioma`);
    noticeOnce(`unsupported:${p}:${target}:${source}`, `${PROVIDERS[p].name} no admite ese idioma; para él se usa el traductor gratuito.`);
    return runFree(text, target, source);
  }
  try {
    return await callProvider(p, text, target, source);
  } catch (err) {
    const recoverable = err.auth || err.quota || err.code === 'COOLDOWN';
    if (!state.fallback || !recoverable) throw err;
    const kind = err.auth ? 'auth' : err.quota ? 'quota' : 'cool';
    noticeOnce(`fallback:${p}:${kind}`, `${err.message[0].toUpperCase()}${err.message.slice(1)}. Mientras tanto se usa el traductor gratuito.`);
    return runFree(text, target, source);
  }
}

/** Traduce con caché LRU, agrupación de peticiones, espaciado y pausas ante 429. */
async function translate(text, target, source = 'auto', signal) {
  const key = `${activeProvider()}\u0001${source}\u0001${target}\u0001${text}`;
  const hit = cache.get(key);
  if (hit) { remember(key, hit); return hit; }

  let p = inflight.get(key);
  if (!p) {
    // La petición compartida no se cancela si un recuadro deja de esperarla
    p = run(text, target, source).then((out) => { remember(key, out); return out; })
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

/** Prueba una clave sin guardarla ni usar la caché. */
async function testKey(provider, key, region) {
  const P = PROVIDERS[provider];
  if (!P || !['deepl', 'microsoft', 'google-cloud'].includes(provider)) throw fail('proveedor no válido');
  if (!key || !key.trim()) throw fail('escribe una clave');
  try {
    const out = provider === 'microsoft'
      ? await P.translate('Hello, how are you?', 'es', 'auto', undefined, key, region || '')
      : await P.translate('Hello, how are you?', 'es', 'auto', undefined, key);
    return out.translated;
  } catch (err) {
    if (err.name === 'TimeoutError') throw fail(`${P.name} no responde; revisa tu conexión`);
    if (!err.status && /fetch|network|ERR_/i.test(err.message)) throw fail(`no se pudo conectar con ${P.name}; revisa tu conexión`);
    throw err;
  }
}

/** Al cambiar de proveedor o de clave se reinician avisos y pausas. */
function resetNotices() { noticed.clear(); }

/** Solo para pruebas. */
function _reset() {
  cache.clear(); inflight.clear(); noticed.clear();
  for (const k of Object.keys(limits)) delete limits[k];
  state.provider = 'google-free'; state.fallback = true; state.msRegion = '';
  state.keys = { deepl: '', 'google-cloud': '', microsoft: '' };
}

module.exports = {
  translate, configure, testKey, cooldownRemaining, activeProvider, resetNotices, ENDPOINT, PROVIDERS, _reset,
};

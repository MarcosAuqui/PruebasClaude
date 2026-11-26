// Proveedor de traducción. Usa el endpoint público de Google Translate,
// que detecta el idioma de origen automáticamente. Está aislado en este
// archivo para poder cambiarlo fácilmente (DeepL, LibreTranslate, etc.).

// net.fetch usa la pila de red de Chromium (respeta proxy del sistema).
let netFetch = globalThis.fetch;
try { netFetch = require('electron').net.fetch; } catch { /* fuera de Electron */ }

const cache = new Map();

async function translate(text, target, source = 'auto') {
  const key = `${source}|${target}|${text}`;
  if (cache.has(key)) return cache.get(key);

  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}`
    + `&dt=t&q=${encodeURIComponent(text)}`;

  const res = await netFetch(url);
  if (!res.ok) throw new Error(`servicio de traducción respondió ${res.status}`);
  const data = await res.json();

  const translated = (data[0] || []).map((seg) => seg[0]).join('');
  const detected = data[2] || source;
  const out = { translated, detected };

  cache.set(key, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = { translate };

const crypto = require('crypto');
const { CODES } = require('./languages');

const SPEEDS = ['fast', 'normal', 'saver'];
const ENHANCE = ['off', 'auto', 'strong'];
const MODES = ['inplace', 'caption', 'panel'];
const PROVIDERS = ['google-free', 'deepl', 'microsoft', 'google-cloud'];

const uid = () => crypto.randomUUID().slice(0, 8);

function defaultBox(n = 1, rect) {
  return {
    id: uid(),
    name: String(n),
    rect: rect || null, // null → se centra en la pantalla principal
    source: 'auto',
    target: 'es',
    mode: 'inplace',
    visible: true,
  };
}

function defaults() {
  return {
    version: 2,
    settings: {
      speed: 'normal',
      enhance: 'auto',
      clickThrough: false,
      closeToTray: true,
      tts: { auto: false, voice: '', rate: 1 },
      // Las claves se guardan cifradas con el sistema (safeStorage)
      translator: {
        provider: 'google-free', fallback: true, deepl: '', microsoft: '', msRegion: '', 'google-cloud': '',
      },
    },
    profiles: [{ id: 'default', name: 'General', app: '', boxes: [defaultBox()] }],
    activeProfileId: 'default',
    mainBounds: null,
  };
}

const pick = (v, list, def) => (list.includes(v) ? v : def);
const str = (v, def = '') => (typeof v === 'string' ? v.slice(0, 120) : def);
const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function sanitizeRect(r) {
  if (!r || typeof r !== 'object') return null;
  const x = num(r.x); const y = num(r.y); const w = num(r.width); const h = num(r.height);
  if ([x, y, w, h].some((v) => v === null)) return null;
  return { x, y, width: Math.max(80, w), height: Math.max(36, h) };
}

function sanitizeBox(b, i) {
  const d = defaultBox(i + 1);
  if (!b || typeof b !== 'object') return d;
  return {
    id: str(b.id) || d.id,
    name: str(b.name) || d.name,
    rect: sanitizeRect(b.rect),
    source: b.source === 'auto' || CODES.has(b.source) ? b.source : 'auto',
    target: CODES.has(b.target) ? b.target : 'es',
    mode: pick(b.mode, MODES, 'inplace'),
    visible: b.visible !== false,
  };
}

function sanitize(data) {
  const d = defaults();
  if (!data || typeof data !== 'object') return d;
  const s = data.settings || {};
  const tts = s.tts || {};
  const tr = s.translator || {};
  const secret = (v) => (typeof v === 'string' && /^(enc|b64):[A-Za-z0-9+/=]{1,4000}$/.test(v) ? v : '');
  const out = {
    version: 2,
    settings: {
      speed: pick(s.speed, SPEEDS, d.settings.speed),
      enhance: pick(s.enhance, ENHANCE, d.settings.enhance),
      clickThrough: !!s.clickThrough,
      closeToTray: s.closeToTray !== false,
      tts: {
        auto: !!tts.auto,
        voice: str(tts.voice),
        rate: Number.isFinite(tts.rate) ? Math.min(2, Math.max(0.5, tts.rate)) : 1,
      },
      translator: {
        provider: pick(tr.provider, PROVIDERS, 'google-free'),
        fallback: tr.fallback !== false,
        deepl: secret(tr.deepl),
        microsoft: secret(tr.microsoft),
        msRegion: typeof tr.msRegion === 'string' && /^[a-z0-9-]{0,40}$/.test(tr.msRegion) ? tr.msRegion : '',
        'google-cloud': secret(tr['google-cloud']),
      },
    },
    profiles: [],
    activeProfileId: str(data.activeProfileId, 'default'),
    mainBounds: sanitizeRect(data.mainBounds),
  };
  const seen = new Set();
  for (const p of Array.isArray(data.profiles) ? data.profiles : []) {
    if (!p || typeof p !== 'object') continue;
    const id = str(p.id) || uid();
    if (seen.has(id)) continue;
    seen.add(id);
    const boxes = (Array.isArray(p.boxes) ? p.boxes : []).slice(0, 8).map(sanitizeBox);
    out.profiles.push({
      id,
      name: str(p.name) || 'Perfil',
      app: str(p.app),
      boxes: boxes.length ? boxes : [defaultBox()],
    });
  }
  if (!out.profiles.length) out.profiles = d.profiles;
  if (!out.profiles.some((p) => p.id === out.activeProfileId)) {
    out.activeProfileId = out.profiles[0].id;
  }
  return out;
}

module.exports = {
  defaults, sanitize, sanitizeBox, defaultBox, uid, SPEEDS, ENHANCE, MODES, PROVIDERS,
};

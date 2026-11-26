/* global api, TTS */
const $ = (id) => document.getElementById(id);

let S = null; // estado público del proceso principal
let selected = null; // id del recuadro seleccionado
let langsBuilt = false;
const results = new Map(); // boxId → último resultado
const statuses = new Map(); // boxId → { text, level }
let historyItems = [];
let historyLimit = 120;
let activeTab = 'translate';

// ---------------------------------------------------------------- utilidades

let displayNames = null;
try { displayNames = new Intl.DisplayNames(['es'], { type: 'language' }); } catch { /* nada */ }
function langName(code) {
  if (!code) return '—';
  const known = S && S.langs.find((l) => l.code === code);
  if (known) return known.name;
  try {
    const n = displayNames && displayNames.of(code);
    if (n) return n.charAt(0).toUpperCase() + n.slice(1);
  } catch { /* código desconocido */ }
  return code.toUpperCase();
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function setSegmented(el, value) {
  el.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.value === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
}
function onSegmented(el, cb) {
  el.querySelectorAll('button').forEach((b) => {
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => { setSegmented(el, b.dataset.value); cb(b.dataset.value); });
  });
}

let noticeTimer;
function notice(text) {
  $('notice-text').textContent = text;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 9000);
}
$('notice-close').onclick = () => { $('notice').hidden = true; };

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copiado';
      setTimeout(() => { btn.textContent = old; }, 1100);
    }
  } catch { notice('No se pudo copiar al portapapeles'); }
}

const box = () => S && S.boxes.find((b) => b.id === selected);

// ---------------------------------------------------------------- pestañas

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${activeTab}`));
    api.watchApps(activeTab === 'settings');
    if (activeTab === 'history') renderHistory();
  });
});

// ---------------------------------------------------------------- render

function buildLangs() {
  if (langsBuilt || !S) return;
  langsBuilt = true;
  const src = $('source');
  const tgt = $('target');
  src.append(option('auto', 'Detectar automáticamente'));
  for (const l of S.langs) {
    src.append(option(l.code, l.name));
    tgt.append(option(l.code, l.name));
  }
}

function render() {
  if (!S) return;
  buildLangs();
  if (!S.boxes.some((b) => b.id === selected)) selected = S.boxes[0].id;

  // Pestañas de recuadros
  const chips = $('box-chips');
  chips.replaceChildren(...S.boxes.map((b) => {
    const c = document.createElement('button');
    c.className = 'box-chip';
    c.classList.toggle('active', b.id === selected);
    c.classList.toggle('off', !b.visible);
    const st = statuses.get(b.id);
    const dot = document.createElement('span');
    dot.className = `dot ${S.running ? (st ? st.level : 'live') : ''}`;
    c.append(dot, document.createTextNode(`Recuadro ${b.name}`));
    c.onclick = () => { selected = b.id; render(); };
    return c;
  }));
  $('btn-add-box').disabled = S.boxes.length >= 6;

  const b = box();
  $('source').value = b.source;
  $('target').value = b.target;
  setSegmented($('mode'), b.mode);
  $('btn-box-visible').classList.toggle('off', !b.visible);
  $('btn-box-visible').title = b.visible ? 'Ocultar este recuadro' : 'Mostrar este recuadro';
  $('btn-box-remove').disabled = S.boxes.length <= 1;

  // Botón único
  const btn = $('btn-toggle');
  btn.textContent = S.running ? 'Finalizar traducción' : 'Iniciar traducción';
  btn.classList.toggle('active', S.running);

  renderStatus();
  renderResult();
  renderSettings();
}

function renderStatus() {
  const st = S.running ? (statuses.get(selected) || { text: 'Iniciando…', level: 'live' }) : { text: 'Detenido', level: 'muted' };
  $('status-text').textContent = st.text;
  $('status').className = `status ${st.level}`;
}

function renderResult() {
  const r = results.get(selected);
  const t = $('translated');
  if (!r) {
    t.classList.add('placeholder');
    t.textContent = S.running ? 'Esperando texto dentro del recuadro…' : 'Coloca el recuadro sobre el texto y pulsa «Iniciar traducción».';
    $('original').textContent = '—';
    $('detected').textContent = '—';
    return;
  }
  t.classList.remove('placeholder');
  t.textContent = r.translated;
  $('original').textContent = r.original;
  $('detected').textContent = `${langName(r.detected)} → ${langName(r.target)}${r.provider ? ` · ${r.provider}` : ''}`;
}

const PROVIDER_HELP = {
  'google-free': 'Sin clave ni cuenta. Google limita las solicitudes por conexión: si traduces mucho, puede pedir esperar unos minutos.',
  deepl: 'Traducciones más naturales. Gratis hasta 500.000 caracteres al mes con una cuenta «DeepL API Free» (pide tarjeta solo para verificar, no cobra).',
  'google-cloud': 'Google Translate oficial: 500.000 caracteres gratis al mes. Requiere un proyecto con «Cloud Translation API» activada y facturación.',
};

function showKeyResult(text, kind) {
  const el = $('key-result');
  el.textContent = text;
  el.className = `small key-result ${kind || ''}`;
  el.hidden = !text;
}

function renderTranslator() {
  const t = S.settings.translator;
  setSegmented($('provider'), t.provider);
  const needsKey = t.provider !== 'google-free';
  $('key-box').hidden = !needsKey;
  $('fallback').checked = t.fallback;
  let help = PROVIDER_HELP[t.provider];
  if (needsKey && !t[t.provider]) help += ' Sin clave guardada: mientras tanto se usa Google gratis.';
  $('provider-help').textContent = help;
  if (needsKey) {
    $('key-saved').textContent = t[t.provider] ? `· guardada ${t[t.provider]}` : '· sin guardar';
    $('btn-key-clear').disabled = !t[t.provider];
    if (t[t.provider] && !t.encrypted) $('key-saved').textContent += ' (sin cifrar: este sistema no ofrece almacén seguro)';
  }
}

function renderSettings() {
  const s = S.settings;
  renderTranslator();
  setSegmented($('speed'), s.speed);
  setSegmented($('enhance'), s.enhance);
  $('click-through').checked = s.clickThrough;
  $('close-to-tray').checked = s.closeToTray;
  $('tts-auto').checked = s.tts.auto;
  $('tts-rate').value = s.tts.rate;
  $('tts-rate-val').textContent = `${Number(s.tts.rate).toFixed(1)}×`;
  $('btn-boxes-visible').textContent = S.boxesVisible ? 'Ocultar todos los recuadros' : 'Mostrar todos los recuadros';
  renderVoices();

  const prof = $('profile');
  prof.replaceChildren(...S.profiles.map((p) => option(p.id, p.name)));
  prof.value = S.activeProfileId;
  const active = S.profiles.find((p) => p.id === S.activeProfileId);
  const apps = [...new Set([active.app, ...S.recentApps].filter(Boolean))];
  const pa = $('profile-app');
  pa.replaceChildren(option('', 'Ninguna'), ...apps.map((a) => option(a, a)));
  pa.value = active.app || '';
  $('btn-profile-delete').disabled = S.profiles.length <= 1;
}

function renderVoices() {
  const sel = $('tts-voice');
  const b = box();
  const lang = (b ? b.target : 'es').slice(0, 2).toLowerCase();
  const voices = TTS.voices().filter((v) => v.lang.toLowerCase().startsWith(lang));
  const key = lang + voices.map((v) => v.name).join('|');
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.replaceChildren(option('', voices.length ? 'Automática (la mejor disponible)' : 'Sin voces para este idioma'), ...voices.map((v) => option(v.name, `${v.name} (${v.lang})`)));
  }
  sel.value = voices.some((v) => v.name === S.settings.tts.voice) ? S.settings.tts.voice : '';
}
TTS.onVoices(() => { if (S) renderVoices(); });

// ---------------------------------------------------------------- historial

function renderHistory() {
  const q = $('history-search').value.trim().toLowerCase();
  const items = [];
  for (let i = historyItems.length - 1; i >= 0; i--) {
    const e = historyItems[i];
    if (!q || e.translated.toLowerCase().includes(q) || e.original.toLowerCase().includes(q)) items.push(e);
  }
  $('history-count').textContent = items.length
    ? `${items.length} traducci${items.length === 1 ? 'ón' : 'ones'}`
    : (q ? 'Sin resultados' : 'Aún no hay traducciones');
  const list = $('history-list');
  list.replaceChildren(...items.slice(0, historyLimit).map((e) => {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'h-head';
    const meta = document.createElement('span');
    meta.textContent = `${new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · R${e.boxName} · ${langName(e.detected)} → ${langName(e.target)}`;
    const acts = document.createElement('span');
    acts.className = 'h-actions';
    const speak = document.createElement('button');
    speak.className = 'ghost xs';
    speak.textContent = 'Escuchar';
    speak.onclick = () => TTS.speak(e.translated, e.target, S.settings.tts);
    const cp = document.createElement('button');
    cp.className = 'ghost xs';
    cp.textContent = 'Copiar';
    cp.onclick = () => copy(e.translated, cp);
    acts.append(speak, cp);
    head.append(meta, acts);
    const tr = document.createElement('p');
    tr.className = 'h-tr';
    tr.textContent = e.translated;
    const or = document.createElement('p');
    or.className = 'h-or';
    or.textContent = e.original;
    li.append(head, tr, or);
    return li;
  }));
  $('btn-more').hidden = items.length <= historyLimit;
}

let historyTimer;
function scheduleHistory() {
  if (activeTab !== 'history') return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(renderHistory, 150);
}

$('history-search').addEventListener('input', () => { historyLimit = 120; scheduleHistory(); });
$('btn-more').onclick = () => { historyLimit += 200; renderHistory(); };
$('btn-export').onclick = async () => {
  const res = await api.historyExport($('export-format').value);
  if (res) notice(`Exportadas ${res.count} traducciones`);
};
$('btn-clear').onclick = async () => {
  const btn = $('btn-clear');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = '¿Seguro? Pulsa otra vez';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Borrar'; }, 3000);
    return;
  }
  btn.dataset.confirm = '';
  btn.textContent = 'Borrar';
  await api.historyClear();
  historyItems = [];
  renderHistory();
};

// ---------------------------------------------------------------- controles

$('btn-min').onclick = () => api.minimize();
$('btn-close').onclick = () => api.close();
$('btn-toggle').onclick = () => api.toggle();
$('btn-add-box').onclick = async () => {
  const id = await api.addBox();
  if (id) selected = id;
};
$('btn-box-remove').onclick = () => { const b = box(); if (b) api.removeBox(b.id); };
$('btn-box-visible').onclick = () => { const b = box(); if (b) api.updateBox(b.id, { visible: !b.visible }); };
$('source').onchange = (e) => { results.delete(selected); api.updateBox(selected, { source: e.target.value }); };
$('target').onchange = (e) => { results.delete(selected); api.updateBox(selected, { target: e.target.value }); };
onSegmented($('mode'), (v) => api.updateBox(selected, { mode: v }));

$('btn-copy').onclick = () => {
  const r = results.get(selected);
  if (r) copy(r.translated, $('btn-copy'));
};
$('btn-speak').onclick = () => {
  const r = results.get(selected);
  if (!r) return;
  if (TTS.speaking()) { TTS.stop(); return; }
  if (!TTS.speak(r.translated, r.target, S.settings.tts)) notice('La lectura en voz alta no está disponible en este sistema');
};

onSegmented($('provider'), (v) => {
  $('api-key').value = '';
  showKeyResult('');
  api.updateSettings({ translator: { provider: v } });
});
$('fallback').onchange = (e) => api.updateSettings({ translator: { fallback: e.target.checked } });
$('api-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-key-save').click(); });
$('btn-key-save').onclick = async () => {
  const provider = S.settings.translator.provider;
  const key = $('api-key').value.trim();
  if (!key) { showKeyResult('Pega primero la clave en el campo.', 'bad'); return; }
  const btn = $('btn-key-save');
  btn.disabled = true;
  showKeyResult('Comprobando la clave…');
  const res = await api.testApiKey(provider, key);
  btn.disabled = false;
  if (!res.ok) { showKeyResult(`No se guardó: ${res.message}`, 'bad'); return; }
  await api.setApiKey(provider, key);
  $('api-key').value = '';
  showKeyResult(`Clave guardada y funcionando. Prueba: «${res.sample}»`, 'ok');
};
$('btn-key-test').onclick = async () => {
  const provider = S.settings.translator.provider;
  if (!$('api-key').value.trim() && !S.settings.translator[provider]) {
    showKeyResult('Pega una clave en el campo o guarda una primero.', 'bad');
    return;
  }
  showKeyResult('Probando…');
  const res = await api.testApiKey(provider, $('api-key').value.trim());
  showKeyResult(res.ok ? `Funciona. Prueba: «${res.sample}»` : `Error: ${res.message}`, res.ok ? 'ok' : 'bad');
};
$('btn-key-clear').onclick = async () => {
  await api.clearApiKey(S.settings.translator.provider);
  showKeyResult('Clave borrada de este equipo.');
};
$('btn-key-help').onclick = () => api.apiKeyHelp(S.settings.translator.provider);

onSegmented($('speed'), (v) => api.updateSettings({ speed: v }));
onSegmented($('enhance'), (v) => api.updateSettings({ enhance: v }));
$('click-through').onchange = (e) => api.updateSettings({ clickThrough: e.target.checked });
$('close-to-tray').onchange = (e) => api.updateSettings({ closeToTray: e.target.checked });
$('tts-auto').onchange = (e) => api.updateSettings({ tts: { auto: e.target.checked } });
$('tts-voice').onchange = (e) => api.updateSettings({ tts: { voice: e.target.value } });
$('tts-rate').oninput = (e) => { $('tts-rate-val').textContent = `${Number(e.target.value).toFixed(1)}×`; };
$('tts-rate').onchange = (e) => api.updateSettings({ tts: { rate: Number(e.target.value) } });
$('btn-boxes-visible').onclick = () => api.toggleBoxes();

$('profile').onchange = (e) => { results.clear(); api.activateProfile(e.target.value); };
$('profile-app').onchange = (e) => api.updateProfile(S.activeProfileId, { app: e.target.value });
$('btn-profile-new').onclick = async () => {
  const name = $('profile-name').value.trim();
  await api.createProfile(name);
  $('profile-name').value = '';
  notice('Perfil creado con los recuadros actuales');
};
$('profile-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-profile-new').click(); });
$('btn-profile-delete').onclick = () => {
  const btn = $('btn-profile-delete');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = '¿Seguro? Pulsa otra vez';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Eliminar perfil activo'; }, 3000);
    return;
  }
  btn.dataset.confirm = '';
  btn.textContent = 'Eliminar perfil activo';
  results.clear();
  api.deleteProfile(S.activeProfileId);
};

// ---------------------------------------------------------------- eventos

api.on('state', (s) => {
  const wasRunning = S && S.running;
  S = s;
  if (!s.running && wasRunning) statuses.clear();
  for (const id of results.keys()) if (!s.boxes.some((b) => b.id === id)) results.delete(id);
  render();
});

api.on('result', (r) => {
  results.set(r.boxId, r);
  if (r.boxId === selected) {
    renderResult();
    if (S.settings.tts.auto) TTS.speak(r.translated, r.target, S.settings.tts);
  }
});

api.on('box-status', ({ boxId, text, level }) => {
  statuses.set(boxId, { text, level });
  if (!S) return;
  if (boxId === selected) renderStatus();
  const idx = S.boxes.findIndex((b) => b.id === boxId);
  const dot = $('box-chips').children[idx]?.querySelector('.dot');
  if (dot) dot.className = `dot ${S.running ? level : ''}`;
});

api.on('history:added', (item) => {
  historyItems.push(item);
  if (historyItems.length > 2000) historyItems.shift();
  scheduleHistory();
});

api.on('notice', notice);
api.on('select-box', (id) => { selected = id; render(); });

(async () => {
  S = await api.getState();
  historyItems = await api.historyList();
  render();
})();

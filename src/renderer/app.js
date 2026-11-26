const SOURCES = [
  ['auto', 'Detectar automáticamente'],
  ['en', 'Inglés'], ['es', 'Español'], ['fr', 'Francés'], ['de', 'Alemán'],
  ['it', 'Italiano'], ['pt', 'Portugués'], ['ru', 'Ruso'], ['ja', 'Japonés'],
  ['ko', 'Coreano'], ['zh-CN', 'Chino (simplificado)'], ['ar', 'Árabe'],
];
const TARGETS = SOURCES.filter(([c]) => c !== 'auto');
const NAMES = Object.fromEntries(SOURCES);

const $ = (id) => document.getElementById(id);
const fill = (sel, list) => {
  sel.innerHTML = list.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
};

fill($('source'), SOURCES);
fill($('target'), TARGETS);

// ---------- Pestañas ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`);
    });
  });
});

// ---------- Controles ----------
$('btn-min').onclick = () => api.minimize();
$('btn-close').onclick = () => api.close();
$('btn-toggle').onclick = () => api.toggle();
$('btn-overlay').onclick = () => api.toggleOverlay();

$('source').onchange = (e) => api.setConfig({ source: e.target.value });
$('target').onchange = (e) => api.setConfig({ target: e.target.value });
$('interval').onchange = (e) => api.setConfig({ interval: Number(e.target.value) });
$('caption').onchange = (e) => api.setConfig({ showCaption: e.target.checked });

$('btn-copy').onclick = async () => {
  const el = $('translated');
  if (el.classList.contains('placeholder')) return;
  await navigator.clipboard.writeText(el.textContent);
  $('btn-copy').textContent = 'Copiado';
  setTimeout(() => { $('btn-copy').textContent = 'Copiar'; }, 1200);
};

// ---------- Eventos desde el proceso principal ----------
function renderState({ running, config }) {
  const btn = $('btn-toggle');
  btn.textContent = running ? 'Finalizar traducción' : 'Iniciar traducción';
  btn.classList.toggle('active', running);
  $('source').value = config.source;
  $('target').value = config.target;
  $('interval').value = String(config.interval);
  $('caption').checked = config.showCaption;
}

api.onState(renderState);
api.getState().then(renderState);

api.onStatus(({ text, level }) => {
  $('status-text').textContent = text;
  $('status').className = `status ${level}`;
});

api.onResult(({ original, translated, detected }) => {
  const t = $('translated');
  t.classList.remove('placeholder');
  t.textContent = translated;
  $('original').textContent = original;
  $('detected').textContent = NAMES[detected] || detected || '—';
});

api.onOverlayVisible((visible) => {
  $('btn-overlay').textContent = visible ? 'Ocultar recuadro' : 'Mostrar recuadro';
});

/* global api */
const $ = (id) => document.getElementById(id);
const layer = $('layer');
const caption = $('caption');

let state = null;
let drag = null;

// ---------------------------------------------------------------- estado

api.on('overlay:state', (s) => {
  state = s;
  const b = document.body;
  b.classList.toggle('live', s.status === 'live');
  b.classList.toggle('error', s.status === 'error');
  b.classList.toggle('click-through', s.clickThrough);
  b.classList.toggle('mode-caption', s.box.mode === 'caption');
  b.style.setProperty('--tab-h', `${s.tabH}px`);
  b.style.setProperty('--caption-h', `${s.captionH - 6}px`);
  $('label').textContent = s.box.name;
  if (s.box.mode !== 'caption') caption.textContent = '';
  if (s.box.mode !== 'inplace') layer.replaceChildren();
});

api.on('overlay:clear', () => {
  layer.replaceChildren();
  caption.textContent = '';
});

api.on('overlay:render', ({ items, caption: text }) => {
  renderLayer(items);
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    caption.replaceChildren(span);
  } else {
    caption.textContent = '';
  }
});

// Respaldo para sistemas que no excluyen la ventana de la captura
api.on('overlay:hide-layer', (id) => {
  layer.classList.add('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => api.overlay.layerHidden(id)));
});
api.on('overlay:show-layer', () => layer.classList.remove('hidden'));

// ------------------------------------------------- traducción integrada

const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

function renderLayer(items) {
  if (!state || drag) { layer.replaceChildren(); return; }
  const inset = state.inset - 1; // el borde de 1px ya desplaza el origen
  const frag = document.createDocumentFragment();
  const els = [];
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'para';
    el.textContent = it.text;
    // Se amplía un poco para tapar por completo el texto original
    const pad = Math.max(2, it.lineH * 0.15);
    el.style.left = `${inset + it.x - pad}px`;
    el.style.top = `${inset + it.y - pad}px`;
    el.style.width = `${it.w + pad * 2}px`;
    el.style.height = `${it.h + pad * 2}px`;
    const bg = it.colors ? it.colors.bg : [11, 13, 16];
    const fg = it.colors ? it.colors.fg : [231, 238, 245];
    el.style.background = rgb(bg);
    el.style.color = rgb(fg);
    el.style.boxShadow = `0 0 3px 2px ${rgb(bg)}`;
    frag.appendChild(el);
    els.push([el, it]);
  }
  layer.replaceChildren(frag);
  // Ajuste del tamaño de letra para que quepa en el hueco original
  for (const [el, it] of els) fitText(el, Math.max(10, Math.min(it.lineH * 0.82, 64)));
}

function fitText(el, start) {
  let lo = 8;
  let hi = start;
  el.style.fontSize = `${hi}px`;
  if (fits(el)) return;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = `${mid}px`;
    if (fits(el)) lo = mid; else hi = mid;
  }
  el.style.fontSize = `${lo}px`;
  if (!fits(el)) el.style.height = 'auto'; // texto largo: se permite crecer
}

const fits = (el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;

// ------------------------------------------------- mover y redimensionar

function currentRect() {
  return {
    x: window.screenX,
    y: window.screenY + state.tabH,
    width: window.innerWidth,
    height: window.innerHeight - state.tabH - (state.box.mode === 'caption' ? state.captionH : 0),
  };
}

function beginDrag(e, dir) {
  if (!state || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  e.target.setPointerCapture(e.pointerId);
  drag = { dir, sx: e.screenX, sy: e.screenY, start: currentRect(), target: e.target, raf: 0, next: null };
  document.body.classList.add('dragging');
  layer.replaceChildren();
  api.overlay.select();
}

function onMove(e) {
  if (!drag) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  let { x, y, width: w, height: h } = drag.start;
  const d = drag.dir;
  if (d === 'move') { x += dx; y += dy; } else {
    if (d.includes('e')) w += dx;
    if (d.includes('s')) h += dy;
    if (d.includes('w')) { w -= dx; x += dx; }
    if (d.includes('n')) { h -= dy; y += dy; }
    if (w < 90) { if (d.includes('w')) x -= 90 - w; w = 90; }
    if (h < 36) { if (d.includes('n')) y -= 36 - h; h = 36; }
  }
  // Un solo cambio de tamaño por fotograma: arrastre fluido
  drag.next = { x, y, width: w, height: h };
  if (!drag.raf) {
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      api.overlay.setRect(drag.next);
    });
  }
}

function endDrag(e) {
  if (!drag) return;
  if (drag.raf) cancelAnimationFrame(drag.raf);
  if (drag.next) api.overlay.setRect(drag.next);
  try { drag.target.releasePointerCapture(e.pointerId); } catch { /* nada */ }
  drag = null;
  document.body.classList.remove('dragging');
  if (state && state.clickThrough && !document.querySelector('.tab:hover, .h:hover')) {
    api.overlay.interactive(false);
  }
}

document.addEventListener('pointermove', onMove);
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

$('tab').addEventListener('pointerdown', (e) => beginDrag(e, 'move'));
$('box').addEventListener('pointerdown', (e) => {
  if (e.target.classList.contains('h')) return;
  if (state && !state.clickThrough) beginDrag(e, 'move');
});
caption.addEventListener('pointerdown', (e) => beginDrag(e, 'move'));
document.querySelectorAll('.h').forEach((h) => {
  h.addEventListener('pointerdown', (e) => beginDrag(e, h.dataset.dir));
});

// ------------------------------------------------- modo atravesable
// La ventana ignora el ratón salvo cuando pasa por el asa o los tiradores.

document.querySelectorAll('.tab, .h').forEach((el) => {
  el.addEventListener('mouseenter', () => { if (state && state.clickThrough) api.overlay.interactive(true); });
  el.addEventListener('mouseleave', () => { if (state && state.clickThrough && !drag) api.overlay.interactive(false); });
});

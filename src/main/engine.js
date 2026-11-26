const { changedBlocks } = require('../shared/imaging');

// Cada cuánto se mira si cambió la imagen (barato) y cuánto se espera como
// máximo a que se estabilice antes de leerla igualmente (vídeo en movimiento).
const POLL = { fast: 110, normal: 240, saver: 700 };
const MAX_WAIT = { fast: 450, normal: 900, saver: 2400 };
const FPS = { fast: 30, normal: 20, saver: 8 };
const CHANGED = 2; // bloques de la huella que deben cambiar

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().replace(/[\s\p{P}]+/gu, '');

/** Similitud de Dice por bigramas (0..1). */
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const [g, c] of ga) inter += Math.min(c, gb.get(g) || 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * inter) / total;
}

/** Bucle independiente de captura → OCR → traducción para un recuadro. */
class BoxRunner {
  constructor(boxWin, ctx) {
    this.bw = boxWin;
    this.ctx = ctx; // { capture, ocr, translate, settings(), exclusion, emit() }
    this.active = false;
    this.zoom = 2;
    this.reset();
  }

  get id() { return this.bw.box.id; }

  reset() {
    this.lastGrabSig = null;
    this.lastOcrSig = null;
    this.lastOcrAt = 0;
    this.lastText = '';
    this.lastKey = '';
    this.displayed = '';
    this.layerShowing = false;
    this.memo = { locked: null };
    this.force = true;
    if (this.abort) this.abort.abort();
    this.abort = null;
  }

  /** Fuerza una nueva lectura (p. ej. tras mover el recuadro). */
  invalidate() {
    this.force = true;
    this.layerShowing = false;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.reset();
    this.bw.setStatus('live');
    this.loop();
  }

  stop() {
    this.active = false;
    if (this.abort) this.abort.abort();
    this.bw.send('overlay:clear');
    this.bw.setStatus('idle');
    this.layerShowing = false;
  }

  async loop() {
    let errors = 0;
    while (this.active) {
      const t0 = Date.now();
      try {
        await this.step();
        if (errors) this.bw.setStatus('live');
        errors = 0;
      } catch (err) {
        if (!this.active || (err && err.name === 'AbortError')) continue;
        errors += 1;
        this.bw.setStatus('error');
        this.ctx.emit('box-status', { boxId: this.id, text: `Error: ${err.message}`, level: 'error' });
      }
      const speed = this.ctx.settings().speed;
      const backoff = errors > 2 ? 6 : 1;
      await sleep(Math.max(10, POLL[speed] * backoff - (Date.now() - t0)));
    }
  }

  async step() {
    const { bw, ctx } = this;
    if (!bw.alive || !bw.box.visible) return;
    const settings = ctx.settings();
    const box = { ...bw.box };

    const needHide = box.mode === 'inplace' && this.layerShowing && !ctx.exclusion.works;
    if (needHide) await bw.hideLayer();
    let g;
    try {
      g = await ctx.capture.grab({
        boxId: box.id,
        rect: bw.captureRect(),
        enhance: settings.enhance,
        zoom: this.zoom,
        fresh: needHide,
        fps: FPS[settings.speed],
      });
    } finally {
      if (needHide) bw.showLayer();
    }
    if (!this.active) return;

    // Ventana protegida capturada en negro (Windows antiguo) → respaldo
    if (this.layerShowing && ctx.exclusion.works && g.mean < 3 && g.std < 1.5) {
      ctx.exclusion.works = false;
      this.force = true;
      return;
    }

    const now = Date.now();
    const changed = changedBlocks(g.sig, this.lastOcrSig) >= CHANGED;
    const stable = changedBlocks(g.sig, this.lastGrabSig) < CHANGED;
    this.lastGrabSig = g.sig;
    const due = now - this.lastOcrAt > MAX_WAIT[settings.speed];
    if (!this.force && !(changed && (stable || due))) return;
    this.force = false;
    this.lastOcrSig = g.sig;
    this.lastOcrAt = now;

    const r = await ctx.ocr.recognize(g.gray, g.w, g.h, box.source, this.memo);
    if (!this.active) return;
    this.adaptZoom(r.medianLineH);

    if (!r.paragraphs.length) {
      if (this.lastText) {
        this.lastText = '';
        this.lastKey = '';
        this.layerShowing = false;
        bw.send('overlay:clear');
      }
      ctx.emit('box-status', { boxId: box.id, text: 'Sin texto legible en el recuadro', level: 'muted' });
      return;
    }

    // ¿La captura incluye nuestra propia traducción? → el sistema no
    // respeta la exclusión: se pasa al modo de respaldo.
    if (this.layerShowing && ctx.exclusion.works && similarity(r.text, this.displayed) > 0.6
      && similarity(r.text, this.lastText) < 0.6) {
      ctx.exclusion.works = false;
      this.force = true;
      return;
    }

    if (this.abort) this.abort.abort();
    const abort = new AbortController();
    this.abort = abort;
    const source = box.source;
    const results = await Promise.all(
      r.paragraphs.map((p) => ctx.translate(p.text, box.target, source, abort.signal)),
    );
    if (!this.active || abort.signal.aborted) return;

    let colors = [];
    if (box.mode === 'inplace') {
      colors = await ctx.capture.sample(box.id, r.paragraphs.map((p) => p.bbox)).catch(() => []);
    }

    const items = r.paragraphs.map((p, i) => ({
      x: p.bbox.x0 / g.pxX,
      y: p.bbox.y0 / g.pxY,
      w: (p.bbox.x1 - p.bbox.x0) / g.pxX,
      h: (p.bbox.y1 - p.bbox.y0) / g.pxY,
      lineH: p.lineH / g.pxY,
      lines: p.lineCount,
      text: results[i].translated,
      same: norm(results[i].translated) === norm(p.text),
      colors: colors[i] || null,
    }));
    const translated = results.map((t) => t.translated).join('\n');
    const inplace = box.mode === 'inplace' ? items.filter((it) => !it.same) : [];
    bw.send('overlay:render', { items: inplace, caption: box.mode === 'caption' ? translated : '' });
    this.layerShowing = inplace.length > 0;
    this.displayed = translated;

    const key = `${box.target}|${r.text}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lastText = r.text;
      ctx.emit('result', {
        boxId: box.id,
        boxName: box.name,
        original: r.text,
        translated,
        detected: results[0].detected,
        target: box.target,
        ts: Date.now(),
      });
    }
    ctx.emit('box-status', { boxId: box.id, text: 'Traduciendo en vivo', level: 'live' });
  }

  /** Ajusta la ampliación para que el texto llegue al OCR a ~34 px de alto. */
  adaptZoom(lineH) {
    if (!lineH) return;
    const ratio = 34 / lineH;
    if (ratio > 0.75 && ratio < 1.4) return;
    this.zoom = Math.min(4, Math.max(1, Math.round(this.zoom * ratio * 4) / 4));
  }
}

module.exports = { BoxRunner, similarity, FPS, POLL };

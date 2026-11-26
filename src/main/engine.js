const { changedBlocks } = require('../shared/imaging');

// Cada cuánto se mira si cambió la imagen (barato) y cuánto se espera como
// máximo a que se estabilice antes de leerla igualmente (vídeo en movimiento).
const POLL = { fast: 110, normal: 240, saver: 700 };
const MAX_WAIT = { fast: 450, normal: 900, saver: 2400 };
const FPS = { fast: 30, normal: 20, saver: 8 };
const CHANGED = 2; // bloques de la huella que deben cambiar
// Tiempo mínimo entre traducciones nuevas de un mismo recuadro
const MIN_GAP = { fast: 400, normal: 700, saver: 1500 };
const SAME_TEXT = 0.85; // similitud a partir de la cual se considera el mismo texto (ruido del OCR)
const OWN_TEXT = 0.55; // similitud con lo que pintamos → la captura nos ve a nosotros

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
    this.recentOut = []; // traducciones pintadas recientemente
    this.paraCache = []; // { src, target, out, detected } por párrafo
    this.lastTranslateAt = 0;
    this.calibrating = false;
    this.fallbackSent = false;
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
        if (err && err.code === 'COOLDOWN') {
          // Pausa del traductor: se mantiene la última traducción y se avisa
          this.force = true;
          this.ctx.emit('box-status', { boxId: this.id, text: `Pausa: ${err.message}`, level: 'warn' });
          await sleep(Math.min(5000, Math.max(1000, err.retryIn || 1000)));
          continue;
        }
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
        freshFrames: ctx.exclusion.waitFrames || 2,
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
    // En modo de respaldo se relee cada ~2 s aunque no cambie la imagen: así
    // se comprueba que ocultar la capa funciona y se detecta texto nuevo debajo
    const recheck = !ctx.exclusion.works && this.layerShowing
      && now - this.lastOcrAt > (this.calibrating ? 450 : 2000);
    if (!this.force && !recheck && !(changed && (stable || due))) return;
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

    // ¿El OCR está leyendo nuestra propia traducción pintada encima? Pasa
    // cuando el sistema no excluye el recuadro de la captura (o el fotograma
    // llega tarde). Nunca se traduce eso: se ignora este fotograma y se
    // refuerza el modo de respaldo (ocultar la capa al capturar).
    if (this.layerShowing && this.isOwnText(r.text)) {
      this.lastOcrSig = g.sig; // no volver a leer este mismo fotograma
      this.calibrating = true; // se reajusta rápido hasta lograr una lectura limpia
      if (ctx.exclusion.works) {
        ctx.exclusion.works = false;
      } else if ((ctx.exclusion.waitFrames || 2) < 6) {
        ctx.exclusion.waitFrames = (ctx.exclusion.waitFrames || 2) + 1;
      } else {
        // Ni ocultando la capa se logra una captura limpia en este equipo:
        // el subtítulo (fuera de la zona capturada) nunca se lee a sí mismo
        bw.send('overlay:clear');
        this.layerShowing = false;
        if (!this.fallbackSent) ctx.emit('fallback-caption', { boxId: box.id });
        this.fallbackSent = true;
      }
      return;
    }

    this.calibrating = false;

    // Párrafos ya traducidos (o casi iguales por ruido del OCR) no se piden otra vez
    const results = r.paragraphs.map((p) => this.cached(p.text, box.target));
    const missing = results.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
    if (missing.length) {
      const wait = MIN_GAP[settings.speed] - (Date.now() - this.lastTranslateAt);
      if (wait > 0) { this.force = true; return; } // demasiado pronto: se reintenta luego
      this.lastTranslateAt = Date.now();
      if (this.abort) this.abort.abort();
      const abort = new AbortController();
      this.abort = abort;
      const fetched = await Promise.all(
        missing.map((i) => ctx.translate(r.paragraphs[i].text, box.target, box.source, abort.signal)),
      );
      if (!this.active || abort.signal.aborted) return;
      missing.forEach((i, k) => {
        results[i] = fetched[k];
        this.remember(r.paragraphs[i].text, box.target, fetched[k]);
      });
    }

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
    if (inplace.length) {
      this.recentOut.push(translated);
      if (this.recentOut.length > 8) this.recentOut.shift();
    }

    // Solo se registra como resultado nuevo si el texto cambió de verdad
    const key = `${box.target}|${r.text}`;
    const sameAsLast = this.lastKey.startsWith(`${box.target}|`) && similarity(r.text, this.lastText) >= SAME_TEXT;
    if (key !== this.lastKey && !sameAsLast) {
      this.lastKey = key;
      this.lastText = r.text;
      ctx.emit('result', {
        boxId: box.id,
        boxName: box.name,
        original: r.text,
        translated,
        detected: results[0].detected,
        provider: results[0].provider || '',
        target: box.target,
        ts: Date.now(),
      });
    }
    ctx.emit('box-status', { boxId: box.id, text: 'Traduciendo en vivo', level: 'live' });
  }

  isOwnText(text) {
    if (similarity(text, this.lastText) >= OWN_TEXT) return false;
    return this.recentOut.some((t) => similarity(text, t) > OWN_TEXT);
  }

  cached(text, target) {
    let best = null;
    let bestSim = SAME_TEXT;
    for (const e of this.paraCache) {
      if (e.target !== target) continue;
      if (e.src === text) return e.res;
      const sim = similarity(text, e.src);
      if (sim >= bestSim) { best = e.res; bestSim = sim; }
    }
    return best;
  }

  remember(src, target, res) {
    this.paraCache.push({ src, target, res });
    if (this.paraCache.length > 40) this.paraCache.shift();
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

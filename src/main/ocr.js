const { createWorker } = require('tesseract.js');
const { AUTO_GROUPS, TESS_BY_CODE } = require('./languages');

const OUTPUT = { text: true, blocks: true, hocr: false, tsv: false };
const IDLE_MS = 3 * 60 * 1000;
const LATIN = AUTO_GROUPS.latin;

// Chino y japonés no separan palabras con espacios (el coreano sí)
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
const CJK_SPACES = new RegExp(`(?<=[${CJK}、。，．！？：；「」『』（）])\\s+(?=[${CJK}、。，．！？：；「」『』（）])`, 'gu');
const IS_CJK = new RegExp(`[${CJK}]`, 'u');
const HAS_LETTER = /\p{L}/u;

/** Arma un PGM (escala de grises) en memoria: Tesseract lo lee sin decodificar. */
function toPGM(gray, w, h) {
  const header = Buffer.from(`P5\n${w} ${h}\n255\n`, 'ascii');
  return Buffer.concat([header, Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength)]);
}

// Símbolos sueltos que Tesseract "ve" en bordes verticales o rayas
const EDGE_JUNK = /^[|¦‖│┃\\/_~•·]+\s+|\s+[|¦‖│┃\\/_~•·]+$/gu;

function cleanLine(text) {
  return text.replace(/[ \t]+/g, ' ').replace(CJK_SPACES, '').trim().replace(EDGE_JUNK, '').replace(/^[|¦‖│┃]+|[|¦‖│┃]+$/gu, '').trim();
}

/**
 * Agrupa líneas en párrafos por cercanía vertical y solapamiento horizontal.
 * Cada párrafo se traduce entero (mejor contexto) y se pinta en su caja.
 */
function groupParagraphs(lines) {
  const sorted = lines.slice().sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const paras = [];
  for (const line of sorted) {
    const lh = line.bbox.y1 - line.bbox.y0;
    // Busca el párrafo compatible más cercano (admite columnas en paralelo)
    let target = null;
    let bestGap = Infinity;
    for (const p of paras) {
      const gap = line.bbox.y0 - p.bbox.y1;
      const overlap = Math.min(line.bbox.x1, p.bbox.x1) - Math.max(line.bbox.x0, p.bbox.x0);
      const similar = lh / p.lineH < 1.7 && p.lineH / lh < 1.7;
      if (gap > -0.4 * p.lineH && gap < 0.9 * p.lineH && overlap > -0.5 * p.lineH && similar && gap < bestGap) {
        target = p;
        bestGap = gap;
      }
    }
    if (target) {
      const p = target;
      p.lines.push(line);
      p.bbox = {
        x0: Math.min(p.bbox.x0, line.bbox.x0),
        y0: Math.min(p.bbox.y0, line.bbox.y0),
        x1: Math.max(p.bbox.x1, line.bbox.x1),
        y1: Math.max(p.bbox.y1, line.bbox.y1),
      };
      p.lineH = (p.lineH * (p.lines.length - 1) + lh) / p.lines.length;
    } else {
      paras.push({ lines: [line], bbox: { ...line.bbox }, lineH: lh });
    }
  }
  return paras.map((p) => {
    let text = '';
    for (const l of p.lines) {
      if (!text) { text = l.text; continue; }
      if (/[\p{Ll}]-$/u.test(text) && /^\p{Ll}/u.test(l.text)) text = text.slice(0, -1) + l.text;
      else if (IS_CJK.test(text.slice(-1)) || IS_CJK.test(l.text[0])) text += l.text;
      else text += ` ${l.text}`;
    }
    const conf = p.lines.reduce((s, l) => s + l.conf, 0) / p.lines.length;
    return { text, bbox: p.bbox, lineH: p.lineH, lineCount: p.lines.length, conf };
  });
}

function parse(data) {
  const lines = [];
  for (const l of data.lines || []) {
    const text = cleanLine(l.text || '');
    if (!text || !HAS_LETTER.test(text) || l.confidence < 40) continue;
    lines.push({ text, bbox: l.bbox, conf: l.confidence });
  }
  const paragraphs = groupParagraphs(lines);
  const conf = lines.length ? lines.reduce((s, l) => s + l.conf, 0) / lines.length : 0;
  const heights = lines.map((l) => l.bbox.y1 - l.bbox.y0).sort((a, b) => a - b);
  // Palabras sin filtrar: indican si hay "algo" escrito aunque el modelo no lo entienda
  const rawWords = (data.words || []).filter((w) => w.text && w.text.trim()).length;
  return {
    paragraphs,
    rawWords,
    conf,
    medianLineH: heights.length ? heights[heights.length >> 1] : 0,
    text: paragraphs.map((p) => p.text).join('\n'),
  };
}

class OcrPool {
  constructor({ cachePath, onStatus }) {
    this.cachePath = cachePath;
    this.onStatus = onStatus || (() => {});
    this.workers = new Map(); // langs → { promise, lastUsed }
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref?.();
  }

  /** Crea (o reutiliza) un worker para un conjunto de idiomas. */
  get(langs) {
    let entry = this.workers.get(langs);
    if (!entry) {
      entry = { promise: this.create(langs), lastUsed: Date.now() };
      this.workers.set(langs, entry);
      entry.promise.catch(() => this.workers.delete(langs));
    }
    entry.lastUsed = Date.now();
    return entry.promise;
  }

  async create(langs) {
    const slow = setTimeout(() => this.onStatus(`Descargando idioma del OCR (${langs})… solo la primera vez`), 1200);
    // Si la descarga falla, tesseract invoca errorHandler y la promesa de
    // createWorker nunca se resuelve: por eso la carrera.
    let fail;
    const failed = new Promise((_, reject) => { fail = reject; });
    failed.catch(() => {});
    try {
      const worker = await Promise.race([
        createWorker(langs.split('+'), 1, {
          cachePath: this.cachePath,
          errorHandler: (err) => fail(new Error(`no se pudo cargar el OCR (${langs}): ${err}`)),
        }),
        failed,
      ]);
      return worker;
    } finally {
      clearTimeout(slow);
    }
  }

  warm(langs = LATIN) { return this.get(langs).then(() => true, () => false); }

  async run(langs, image) {
    const worker = await this.get(langs);
    const { data } = await worker.recognize(image, {}, OUTPUT);
    return { ...parse(data), langs };
  }

  /**
   * Reconoce el texto. Con source 'auto' detecta el alfabeto probando
   * los modelos en paralelo y "fija" el ganador para ese recuadro.
   */
  async recognize(gray, w, h, source, memo) {
    const image = toPGM(gray, w, h);
    if (source !== 'auto') return this.run(TESS_BY_CODE[source] || LATIN, image);

    const tried = new Map();
    const tryLangs = (langs) => {
      if (!tried.has(langs)) tried.set(langs, this.run(langs, image));
      return tried.get(langs);
    };

    if (memo.locked) {
      const r = await tryLangs(memo.locked);
      if (!r.paragraphs.length || r.conf >= 60) return r;
    }
    const latin = await tryLangs(LATIN);
    if (!latin.rawWords && !latin.paragraphs.length) return latin; // no hay texto
    if (latin.conf >= 80) { memo.locked = LATIN; return latin; }
    // Si la última detección no encontró nada claro, no repetirla enseguida
    if (memo.failedAt && Date.now() - memo.failedAt < 3000) return latin;

    const others = Object.values(AUTO_GROUPS).filter((l) => !tried.has(l));
    others.forEach(tryLangs); // todos en paralelo, cada uno en su worker
    const settled = await Promise.allSettled([...tried.values()]);
    let best = latin;
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value.paragraphs.length && s.value.conf > best.conf) best = s.value;
    }
    if (best.conf >= 50) { memo.locked = best.langs; memo.failedAt = 0; } else memo.failedAt = Date.now();
    return best;
  }

  /** Libera workers sin uso (excepto el latino, que se mantiene caliente). */
  sweep() {
    const now = Date.now();
    for (const [langs, entry] of this.workers) {
      if (langs === LATIN || now - entry.lastUsed < IDLE_MS) continue;
      this.workers.delete(langs);
      entry.promise.then((w) => w.terminate()).catch(() => {});
    }
  }

  async dispose() {
    clearInterval(this.sweeper);
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(all.map((e) => e.promise.then((w) => w.terminate())));
  }
}

module.exports = { OcrPool, groupParagraphs, toPGM, parse };

// Procesado de imagen puro (sin dependencias). Se usa tanto en la ventana
// de captura (navegador) como en el proceso principal (Node).
(function (root) {
  'use strict';

  /**
   * Convierte RGBA/BGRA a escala de grises y la mejora para el OCR.
   * mode: 'off' | 'auto' | 'strong'
   * - auto: estira el contraste e invierte si el fondo es oscuro
   *   (Tesseract lee mucho mejor texto oscuro sobre fondo claro).
   * - strong: además binariza con el umbral de Otsu.
   */
  function preprocess(px, w, h, mode, bgra) {
    const n = w * h;
    const gray = new Uint8Array(n);
    const ri = bgra ? 2 : 0;
    const bi = bgra ? 0 : 2;
    const hist = new Uint32Array(256);
    let sum = 0;
    let sumSq = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = (px[j + ri] * 54 + px[j + 1] * 183 + px[j + bi] * 19) >> 8;
      gray[i] = v;
      hist[v]++;
      sum += v;
      sumSq += v * v;
    }
    const mean = n ? sum / n : 0;
    const std = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
    if (mode === 'off' || n === 0) return { gray, mean, std, inverted: false };

    // Percentiles 1 % y 99 % para estirar el contraste
    const lo = percentile(hist, n, 0.01);
    const hi = percentile(hist, n, 0.99);
    const range = Math.max(1, hi - lo);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = clamp(Math.round(((v - lo) * 255) / range));
    }

    // Histograma tras el estiramiento → Otsu → polaridad del fondo
    const h2 = new Uint32Array(256);
    for (let v = 0; v < 256; v++) h2[lut[v]] += hist[v];
    const t = otsu(h2, n);
    let dark = 0;
    for (let v = 0; v < t; v++) dark += h2[v];
    const invert = dark > n / 2; // la mayoría (el fondo) es oscura

    for (let v = 0; v < 256; v++) {
      const s = lut[v];
      if (mode === 'strong') {
        const isText = invert ? s >= t : s < t;
        lut[v] = isText ? 0 : 255;
      } else {
        lut[v] = invert ? 255 - s : s;
      }
    }
    for (let i = 0; i < n; i++) gray[i] = lut[gray[i]];
    return { gray, mean, std, inverted: invert };
  }

  function percentile(hist, n, p) {
    const target = n * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  }

  function otsu(hist, n) {
    let sumAll = 0;
    for (let v = 0; v < 256; v++) sumAll += v * hist[v];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let t = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = v + 1; }
    }
    return t;
  }

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  /** Huella pequeña (media por bloques) para detectar cambios baratos. */
  function signature(gray, w, h, sw, sh) {
    sw = sw || 48;
    sh = sh || 12;
    const out = new Uint8Array(sw * sh);
    const step = w * h > 1_500_000 ? 2 : 1;
    for (let by = 0; by < sh; by++) {
      const y0 = Math.floor((by * h) / sh);
      const y1 = Math.max(y0 + 1, Math.floor(((by + 1) * h) / sh));
      for (let bx = 0; bx < sw; bx++) {
        const x0 = Math.floor((bx * w) / sw);
        const x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * w) / sw));
        let s = 0;
        let c = 0;
        // Promedio completo (preciso con trazos finos); paso 2 en imágenes grandes
        for (let y = y0; y < y1 && y < h; y += step) {
          const row = y * w;
          for (let x = x0; x < x1 && x < w; x += step) { s += gray[row + x]; c++; }
        }
        out[by * sw + bx] = c ? Math.round(s / c) : 0;
      }
    }
    return out;
  }

  /**
   * Cuántos bloques de la huella cambiaron de forma apreciable. Detecta
   * cambios locales (una sola línea) sin reaccionar al ruido de vídeo.
   */
  function changedBlocks(a, b, threshold) {
    if (!a || !b || a.length !== b.length) return Infinity;
    const t = threshold || 12;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > t) n++;
    return n;
  }

  /** Diferencia media absoluta entre dos huellas (0 = idénticas). */
  function sigDiff(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d / a.length;
  }

  /**
   * Color de fondo y de texto de cada rectángulo (para pintar la
   * traducción "integrada" sobre el texto original).
   */
  function sampleColors(rgba, w, h, rects) {
    return rects.map((r) => {
      const x0 = Math.max(0, Math.floor(r.x0) - 3);
      const y0 = Math.max(0, Math.floor(r.y0) - 3);
      const x1 = Math.min(w - 1, Math.ceil(r.x1) + 3);
      const y1 = Math.min(h - 1, Math.ceil(r.y1) + 3);
      if (x1 <= x0 || y1 <= y0) return null;
      const R = [];
      const G = [];
      const B = [];
      const push = (x, y) => {
        const j = (y * w + x) * 4;
        R.push(rgba[j]); G.push(rgba[j + 1]); B.push(rgba[j + 2]);
      };
      const stepX = Math.max(1, ((x1 - x0) / 60) | 0);
      const stepY = Math.max(1, ((y1 - y0) / 20) | 0);
      for (let x = x0; x <= x1; x += stepX) { push(x, y0); push(x, y1); }
      for (let y = y0; y <= y1; y += stepY) { push(x0, y); push(x1, y); }
      const bg = [median(R), median(G), median(B)];

      // Texto: los píxeles interiores más alejados del fondo
      const far = [];
      const sx = Math.max(1, ((x1 - x0) / 120) | 0);
      const sy = Math.max(1, ((y1 - y0) / 40) | 0);
      for (let y = y0 + 3; y < y1 - 3; y += sy) {
        for (let x = x0 + 3; x < x1 - 3; x += sx) {
          const j = (y * w + x) * 4;
          const d = Math.abs(rgba[j] - bg[0]) + Math.abs(rgba[j + 1] - bg[1]) + Math.abs(rgba[j + 2] - bg[2]);
          if (d > 90) far.push([d, rgba[j], rgba[j + 1], rgba[j + 2]]);
        }
      }
      let fg;
      if (far.length) {
        far.sort((a, b) => b[0] - a[0]);
        const top = far.slice(0, Math.max(1, Math.ceil(far.length * 0.3)));
        fg = [0, 1, 2].map((k) => Math.round(top.reduce((s, p) => s + p[k + 1], 0) / top.length));
      }
      // Garantizar contraste legible
      if (!fg || contrast(fg, bg) < 3) fg = luminance(bg) > 0.45 ? [17, 20, 24] : [240, 244, 248];
      return { bg, fg };
    });
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  function luminance([r, g, b]) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  const api = {
    preprocess, signature, sigDiff, changedBlocks, sampleColors, contrast,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Imaging = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));

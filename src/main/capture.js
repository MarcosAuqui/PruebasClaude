const path = require('path');
const {
  BrowserWindow, ipcMain, desktopCapturer, screen,
} = require('electron');
const Imaging = require('../shared/imaging');

/**
 * Cliente de la ventana de captura. Si el stream de pantalla falla varias
 * veces (p. ej. Wayland sin portal), cae al método clásico con
 * desktopCapturer, más lento pero universal.
 */
class Capture {
  constructor() {
    this.win = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.sources = null;
    this.failures = 0;
    this.fallback = false;
    this.fallbackRaw = new Map();

    ipcMain.on('capture:res', (e, msg) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error));
    });

    const invalidate = () => { this.sources = null; this.release(); };
    screen.on('display-added', invalidate);
    screen.on('display-removed', invalidate);
    screen.on('display-metrics-changed', invalidate);
  }

  init() {
    if (this.ready) return this.ready;
    this.win = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    this.win.webContents.on('render-process-gone', () => {
      // Si el proceso de captura muere, se recrea en la siguiente captura
      this.rejectAll(new Error('el proceso de captura se reinició'));
      this.ready = null;
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
      this.win = null;
    });
    this.ready = this.win.loadFile(path.join(__dirname, '..', 'capture', 'capture.html'));
    return this.ready;
  }

  rejectAll(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  async call(type, payload, timeout = 4000) {
    await this.init();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('la captura tardó demasiado'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.win.webContents.send('capture:req', { id, type, payload });
    });
  }

  async sourceFor(display) {
    if (!this.sources) {
      this.sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    }
    const byId = this.sources.find((s) => s.display_id && s.display_id === String(display.id));
    if (byId) return byId;
    const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
    return this.sources[idx] || this.sources[0];
  }

  /** Recorta y preprocesa una zona (coordenadas DIP de pantalla). */
  async grab({
    boxId, rect, enhance, zoom, fresh, freshFrames, fps,
  }) {
    const display = screen.getDisplayMatching(rect);
    if (!this.fallback) {
      try {
        const src = await this.sourceFor(display);
        if (!src) throw new Error('no hay pantallas disponibles');
        const sf = display.scaleFactor || 1;
        const out = await this.call('grab', {
          boxId,
          sourceId: src.id,
          physW: Math.round(display.size.width * sf),
          physH: Math.round(display.size.height * sf),
          fps,
          display: display.bounds,
          rect,
          zoom,
          enhance,
          fresh,
          freshFrames,
        });
        this.failures = 0;
        return out;
      } catch (err) {
        this.failures += 1;
        if (this.failures >= 3) {
          this.fallback = true;
          console.warn('Captura por stream no disponible, usando método clásico:', err.message);
        } else {
          throw err;
        }
      }
    }
    return this.grabClassic({ boxId, rect, enhance, zoom, display });
  }

  async grabClassic({ boxId, rect, enhance, zoom, display }) {
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!src) throw new Error('no se pudo capturar la pantalla');
    const img = src.thumbnail;
    const size = img.getSize();
    const kx = size.width / display.bounds.width;
    const ky = size.height / display.bounds.height;
    const x = Math.max(0, Math.round((rect.x - display.bounds.x) * kx));
    const y = Math.max(0, Math.round((rect.y - display.bounds.y) * ky));
    const width = Math.max(1, Math.min(size.width - x, Math.round(rect.width * kx)));
    const height = Math.max(1, Math.min(size.height - y, Math.round(rect.height * ky)));
    let crop = img.crop({ x, y, width, height });
    const z = Math.min(zoom, Math.sqrt(3_000_000 / (width * height)));
    if (z > 1.01) crop = crop.resize({ width: Math.round(width * z), height: Math.round(height * z), quality: 'best' });
    const { width: w, height: h } = crop.getSize();
    const bgra = crop.toBitmap();
    // Copia en RGBA para el muestreo de colores
    const rgba = new Uint8ClampedArray(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255;
    }
    this.fallbackRaw.set(boxId, { rgba, w, h });
    const pre = Imaging.preprocess(rgba, w, h, enhance, false);
    return {
      gray: pre.gray,
      w,
      h,
      pxX: w / rect.width,
      pxY: h / rect.height,
      sig: Imaging.signature(pre.gray, w, h),
      mean: pre.mean,
      std: pre.std,
    };
  }

  async sample(boxId, rects) {
    if (this.fallback) {
      const raw = this.fallbackRaw.get(boxId);
      return raw ? Imaging.sampleColors(raw.rgba, raw.w, raw.h, rects) : [];
    }
    return this.call('sample', { boxId, rects }, 1500);
  }

  forget(boxId) {
    this.fallbackRaw.delete(boxId);
    if (this.win) this.call('forget', { boxId }, 1000).catch(() => {});
  }

  /** Cierra los streams (se apaga el indicador de grabación del sistema). */
  release() {
    this.fallbackRaw.clear();
    if (this.win && !this.win.isDestroyed()) this.call('release', {}, 1000).catch(() => {});
  }

  destroy() {
    this.rejectAll(new Error('cerrando'));
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Capture };

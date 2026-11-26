const path = require('path');
const { BrowserWindow, screen } = require('electron');

const TAB_H = 20; // pestaña superior (asa) fuera de la zona capturada
const CAPTION_H = 78; // franja de subtítulo bajo el recuadro
const INSET = 4; // margen que no se captura (borde del recuadro)
const MIN_W = 90;
const MIN_H = 36;

/** Ventana transparente de un recuadro. */
class BoxWindow {
  constructor(box, { onRectChange, clickThrough, isShown }) {
    this.box = box;
    this.mode = box.mode; // copia propia: el objeto box se comparte y se muta
    this.isShown = isShown || (() => true);
    this.onRectChange = onRectChange;
    this.clickThrough = clickThrough;
    this.status = 'idle';
    this.layerAck = new Map();
    this.ensureRect();

    this.win = new BrowserWindow({
      ...this.windowBounds(),
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false, // no roba el foco al juego / vídeo de debajo
      alwaysOnTop: true,
      title: `Recuadro ${box.name}`,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Excluye el recuadro (y la traducción pintada encima) de las capturas
    this.win.setContentProtection(true);
    this.win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
    this.win.webContents.on('did-finish-load', () => this.pushState());
    this.win.once('ready-to-show', () => {
      if (this.box.visible && this.isShown()) this.win.showInactive();
      this.applyClickThrough(this.clickThrough);
    });
  }

  get alive() { return this.win && !this.win.isDestroyed(); }

  /** Si no tiene posición o quedó fuera de las pantallas, se centra. */
  ensureRect() {
    const r = this.box.rect;
    const visible = r && screen.getAllDisplays().some(({ workArea: a }) => (
      r.x < a.x + a.width - 40 && r.x + r.width > a.x + 40 && r.y < a.y + a.height - 20 && r.y > a.y - 10
    ));
    if (visible) return;
    const { workArea: a } = screen.getPrimaryDisplay();
    const w = Math.min(560, a.width - 80);
    const h = 150;
    const n = Number(this.box.name) || 1;
    this.box.rect = {
      x: Math.round(a.x + (a.width - w) / 2 + (n - 1) * 30),
      y: Math.round(a.y + (a.height - h) / 2 + (n - 1) * 30),
      width: w,
      height: h,
    };
  }

  windowBounds() {
    const r = this.box.rect;
    return {
      x: r.x,
      y: r.y - TAB_H,
      width: r.width,
      height: r.height + TAB_H + (this.box.mode === 'caption' ? CAPTION_H : 0),
    };
  }

  /** Zona que se captura (DIP de pantalla). */
  captureRect() {
    const r = this.box.rect;
    return {
      x: r.x + INSET,
      y: r.y + INSET,
      width: Math.max(1, r.width - INSET * 2),
      height: Math.max(1, r.height - INSET * 2),
    };
  }

  setRect(rect) {
    const r = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(MIN_W, Math.round(rect.width)),
      height: Math.max(MIN_H, Math.round(rect.height)),
    };
    const old = this.box.rect;
    if (old && old.x === r.x && old.y === r.y && old.width === r.width && old.height === r.height) return;
    this.box.rect = r;
    if (this.alive) this.win.setBounds(this.windowBounds());
    this.send('overlay:clear');
    this.onRectChange(this);
  }

  /** Aplica cambios de configuración del recuadro (modo, nombre, visible). */
  update(box) {
    const modeChanged = box.mode !== this.mode;
    this.mode = box.mode;
    this.box = box;
    this.ensureRect();
    if (!this.alive) return;
    if (modeChanged) {
      this.win.setBounds(this.windowBounds());
      this.send('overlay:clear');
    }
    this.setVisible(box.visible);
    this.pushState();
  }

  setVisible(v) {
    if (!this.alive) return;
    v = v && this.isShown();
    if (v && !this.win.isVisible()) this.win.showInactive();
    if (!v && this.win.isVisible()) this.win.hide();
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.pushState();
  }

  applyClickThrough(enabled) {
    this.clickThrough = enabled;
    if (!this.alive) return;
    this.win.setIgnoreMouseEvents(enabled, { forward: true });
    this.pushState();
  }

  /** En modo atravesable, el asa vuelve interactiva la ventana al pasar por encima. */
  setInteractive(on) {
    if (!this.alive || !this.clickThrough) return;
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  pushState() {
    this.send('overlay:state', {
      box: this.box,
      status: this.status,
      clickThrough: this.clickThrough,
      tabH: TAB_H,
      captionH: CAPTION_H,
      inset: INSET,
    });
  }

  send(channel, data) {
    if (this.alive) this.win.webContents.send(channel, data);
  }

  /** Respaldo si el sistema no excluye la ventana de la captura. */
  hideLayer() {
    if (!this.alive) return Promise.resolve();
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.layerAck.delete(id); resolve(); }, 300);
      this.layerAck.set(id, () => { clearTimeout(timer); resolve(); });
      this.send('overlay:hide-layer', id);
    });
  }

  layerHidden(id) {
    const fn = this.layerAck.get(id);
    if (fn) { this.layerAck.delete(id); fn(); }
  }

  showLayer() { this.send('overlay:show-layer'); }

  destroy() {
    for (const fn of this.layerAck.values()) fn();
    this.layerAck.clear();
    if (this.alive) this.win.destroy();
  }
}

module.exports = {
  BoxWindow, TAB_H, CAPTION_H, INSET,
};

const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut,
} = require('electron');
const path = require('path');
const crypto = require('crypto');
const { createWorker } = require('tesseract.js');
const { translate } = require('./translator');
const { OCR_LANGS } = require('./languages');

// Alto de la franja de subtítulo bajo el recuadro (no se captura).
const CAPTION_H = 72;
// Margen interior que se recorta para no leer el borde del recuadro.
const INSET = 4;

let mainWin = null;
let overlayWin = null;
let worker = null;
let workerLangs = null;
let timer = null;
let running = false;
let lastSig = '';
let lastText = '';

const config = {
  source: 'auto',
  target: 'es',
  interval: 1500,
  showCaption: true,
};

// ---------- Ventanas ----------

function createMainWindow() {
  // Formato vertical 9:16
  mainWin = new BrowserWindow({
    width: 405,
    height: 720,
    minWidth: 360,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0B0D10',
    title: 'Traductor de Pantalla',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  mainWin.setAspectRatio(9 / 16);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
}

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = 520;
  const h = 160 + (config.showCaption ? CAPTION_H : 0);
  overlayWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + (workArea.height - h) / 2),
    transparent: true,
    frame: false,
    resizable: false, // el redimensionado lo hacen los tiradores propios
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlayWin.webContents.on('did-finish-load', pushOverlayState);
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function status(text, level = 'info') {
  send(mainWin, 'status', { text, level });
}

function pushOverlayState() {
  send(overlayWin, 'overlay:state', {
    running,
    showCaption: config.showCaption,
    captionH: CAPTION_H,
  });
}

function pushState() {
  send(mainWin, 'state', { running, config });
  pushOverlayState();
}

// ---------- OCR ----------

async function ensureWorker() {
  const langs = (OCR_LANGS[config.source] || OCR_LANGS.auto);
  if (worker && workerLangs === langs) return worker;
  status('Preparando lector de texto (OCR)…');
  if (worker) await worker.terminate();
  worker = null;
  // Si falla la descarga de idiomas, tesseract llama a errorHandler y la
  // promesa de createWorker nunca se resuelve: por eso la "carrera".
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {});
  const w = await Promise.race([
    createWorker(langs.split('+'), 1, {
      cachePath: path.join(app.getPath('userData'), 'tessdata'),
      errorHandler: (err) => fail(new Error(
        `no se pudieron cargar los idiomas del OCR (¿sin internet?): ${err}`,
      )),
    }),
    failed,
  ]);
  worker = w;
  workerLangs = langs;
  return worker;
}

// ---------- Captura del recuadro ----------

async function captureRegion() {
  const b = overlayWin.getBounds();
  const boxH = b.height - (config.showCaption ? CAPTION_H : 0);
  const display = screen.getDisplayMatching(b);
  const sf = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf),
    },
  });
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src) throw new Error('No se pudo capturar la pantalla');

  const img = src.thumbnail;
  const size = img.getSize();
  const kx = size.width / display.bounds.width;
  const ky = size.height / display.bounds.height;

  let x = Math.round((b.x - display.bounds.x + INSET) * kx);
  let y = Math.round((b.y - display.bounds.y + INSET) * ky);
  let width = Math.round((b.width - INSET * 2) * kx);
  let height = Math.round((boxH - INSET * 2) * ky);
  // Limitar a la pantalla
  x = Math.max(0, x);
  y = Math.max(0, y);
  width = Math.max(1, Math.min(width, size.width - x));
  height = Math.max(1, Math.min(height, size.height - y));

  let crop = img.crop({ x, y, width, height });
  // Texto pequeño: ampliar para que el OCR lo lea mejor
  if (height < 120) {
    crop = crop.resize({ width: width * 2, height: height * 2, quality: 'best' });
  }
  return crop;
}

function cleanText(t) {
  return t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

// ---------- Bucle de traducción ----------

async function tick() {
  if (!running) return;
  try {
    if (!worker) return; // el OCR se está recargando
    const img = await captureRegion();
    const sig = crypto.createHash('md5').update(img.toBitmap()).digest('hex');

    if (sig !== lastSig) {
      lastSig = sig;
      const { data } = await worker.recognize(img.toPNG());
      const text = cleanText(data.text || '');

      if (!text || data.confidence < 35) {
        status('Sin texto legible en el recuadro', 'muted');
      } else if (text !== lastText) {
        lastText = text;
        status('Traduciendo…');
        const res = await translate(text, config.target, config.source);
        if (!running) return;
        const result = { original: text, ...res, at: Date.now() };
        send(mainWin, 'result', result);
        send(overlayWin, 'overlay:caption', result.translated);
        status('Traduciendo en vivo', 'live');
      }
    }
  } catch (err) {
    status(`Error: ${err.message}`, 'error');
  } finally {
    if (running) timer = setTimeout(tick, config.interval);
  }
}

async function start() {
  if (running) return;
  running = true;
  lastSig = '';
  lastText = '';
  pushState();
  try {
    await ensureWorker();
    status('Traduciendo en vivo', 'live');
    tick();
  } catch (err) {
    running = false;
    pushState();
    status(`No se pudo iniciar el OCR: ${err.message}`, 'error');
  }
}

function stop() {
  running = false;
  clearTimeout(timer);
  timer = null;
  pushState();
  send(overlayWin, 'overlay:caption', '');
  status('Detenido', 'muted');
}

function toggle() {
  if (running) stop(); else start();
}

// ---------- IPC ----------

ipcMain.handle('toggle', () => { toggle(); return running; });
ipcMain.handle('get-state', () => ({ running, config }));

ipcMain.handle('set-config', async (_e, patch) => {
  const prevCaption = config.showCaption;
  const prevSource = config.source;
  Object.assign(config, patch);

  if (overlayWin && prevCaption !== config.showCaption) {
    const b = overlayWin.getBounds();
    const delta = config.showCaption ? CAPTION_H : -CAPTION_H;
    overlayWin.setBounds({ ...b, height: b.height + delta });
  }
  // Forzar retraducción con la nueva configuración
  lastText = '';
  lastSig = '';
  if (running && prevSource !== config.source) {
    try { await ensureWorker(); status('Traduciendo en vivo', 'live'); } catch (err) {
      status(`Error OCR: ${err.message}`, 'error');
    }
  }
  pushState();
  return config;
});

ipcMain.on('overlay:set-bounds', (_e, b) => {
  if (!overlayWin) return;
  const extra = config.showCaption ? CAPTION_H : 0;
  overlayWin.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(120, Math.round(b.width)),
    height: Math.max(50 + extra, Math.round(b.height)),
  });
});

ipcMain.on('overlay:toggle-visible', () => {
  if (!overlayWin) return;
  if (overlayWin.isVisible()) overlayWin.hide(); else overlayWin.showInactive();
  send(mainWin, 'overlay-visible', overlayWin.isVisible());
});

ipcMain.on('win:minimize', () => mainWin && mainWin.minimize());
ipcMain.on('win:close', () => mainWin && mainWin.close());

// ---------- Ciclo de vida ----------

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  // Atajo global: iniciar / finalizar traducción
  globalShortcut.register('CommandOrControl+Shift+T', toggle);
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  if (worker) await worker.terminate();
});

app.on('window-all-closed', () => app.quit());

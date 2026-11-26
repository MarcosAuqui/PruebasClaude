const path = require('path');
const {
  app, BrowserWindow, ipcMain, globalShortcut, dialog, session, systemPreferences, screen,
} = require('electron');
const { JsonFile } = require('./json-file');
const config = require('./config');
const { History } = require('./history');
const { OcrPool } = require('./ocr');
const { translate, ENDPOINT } = require('./translator');
const { Capture } = require('./capture');
const { BoxWindow } = require('./box-window');
const { BoxRunner } = require('./engine');
const { ForegroundWatcher } = require('./foreground');
const { AppTray } = require('./tray');
const { LANGS } = require('./languages');

const ROOT = path.join(__dirname, '..');
const MAX_BOXES = 6;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => showMain());

let store; let cfg; let history; let ocr; let capture; let tray; let watcher;
let mainWin = null;
let mainReady = false;
const mainQueue = [];
let running = false;
let quitting = false;
let boxesVisible = true;
let autoProfile = null; // { prev } si el perfil se activó por la app en primer plano
let watchRequested = false;
const recentApps = [];
const boxWins = new Map(); // boxId → BoxWindow
const runners = new Map(); // boxId → BoxRunner
const boxStatus = new Map(); // boxId → { text, level }
const exclusion = { works: process.platform === 'win32' || process.platform === 'darwin' };

const profile = () => cfg.profiles.find((p) => p.id === cfg.activeProfileId);
const boxes = () => profile().boxes;
const findBox = (id) => boxes().find((b) => b.id === id);

// ---------------------------------------------------------------- estado

function publicState() {
  return {
    running,
    settings: cfg.settings,
    boxes: boxes(),
    boxStatus: Object.fromEntries(boxStatus),
    profiles: cfg.profiles.map(({ id, name, app: a }) => ({ id, name, app: a })),
    activeProfileId: cfg.activeProfileId,
    recentApps,
    boxesVisible,
    langs: LANGS.map(([code, name]) => ({ code, name })),
    platform: process.platform,
  };
}

let stateQueued = false;
function broadcast() {
  // Agrupa varios cambios seguidos en un solo envío
  if (stateQueued) return;
  stateQueued = true;
  queueMicrotask(() => {
    stateQueued = false;
    sendMain('state', publicState());
    if (tray) tray.update({ ...publicState(), clickThrough: cfg.settings.clickThrough });
  });
}

function sendMain(channel, data) {
  if (!mainWin || mainWin.isDestroyed()) return;
  // Los avisos emitidos antes de que cargue la interfaz se entregan después
  if (!mainReady) { if (channel === 'notice') mainQueue.push([channel, data]); return; }
  mainWin.webContents.send(channel, data);
}

function persist() { store.save(); }

// ---------------------------------------------------------------- recuadros

function syncBoxWindows() {
  const wanted = new Map(boxes().map((b) => [b.id, b]));
  for (const [id, bw] of boxWins) {
    if (!wanted.has(id)) {
      runners.get(id)?.stop();
      runners.delete(id);
      bw.destroy();
      boxWins.delete(id);
      boxStatus.delete(id);
      capture?.forget(id);
    }
  }
  for (const [id, box] of wanted) {
    let bw = boxWins.get(id);
    if (!bw) {
      bw = new BoxWindow(box, {
        clickThrough: cfg.settings.clickThrough,
        isShown: () => boxesVisible,
        onRectChange: (w) => { runners.get(w.box.id)?.invalidate(); persist(); },
      });
      boxWins.set(id, bw);
      const runner = new BoxRunner(bw, engineCtx);
      runners.set(id, runner);
      if (running) runner.start();
    } else {
      bw.update(box);
    }
  }
  persist();
  broadcast();
}

const engineCtx = {
  get capture() { return capture; },
  get ocr() { return ocr; },
  translate,
  exclusion,
  settings: () => cfg.settings,
  emit(type, data) {
    if (type === 'result') {
      const item = history.add({ ...data, profile: profile().name });
      sendMain('result', data);
      if (item) sendMain('history:added', item);
    } else if (type === 'box-status') {
      const prev = boxStatus.get(data.boxId);
      if (prev && prev.text === data.text) return;
      boxStatus.set(data.boxId, { text: data.text, level: data.level });
      sendMain('box-status', data);
    }
  },
};

function addBox() {
  const list = boxes();
  if (list.length >= MAX_BOXES) return null;
  const used = new Set(list.map((b) => b.name));
  let n = 1;
  while (used.has(String(n))) n += 1;
  const last = list[list.length - 1];
  const rect = last && last.rect
    ? { ...last.rect, y: last.rect.y + last.rect.height + 36 }
    : null;
  const box = config.defaultBox(n, rect);
  if (last) { box.source = last.source; box.target = last.target; box.mode = last.mode; }
  list.push(box);
  syncBoxWindows();
  return box.id;
}

function removeBox(id) {
  const p = profile();
  if (p.boxes.length <= 1) return false;
  p.boxes = p.boxes.filter((b) => b.id !== id);
  syncBoxWindows();
  return true;
}

function updateBox(id, patch) {
  const box = findBox(id);
  if (!box) return;
  const merged = config.sanitizeBox({ ...box, ...patch, id: box.id, rect: box.rect }, 0);
  const langChanged = merged.source !== box.source || merged.target !== box.target;
  const modeChanged = merged.mode !== box.mode;
  Object.assign(box, merged);
  boxWins.get(id)?.update(box);
  if (langChanged || modeChanged) {
    const r = runners.get(id);
    if (r && r.active) { r.reset(); boxWins.get(id).send('overlay:clear'); }
  }
  persist();
  broadcast();
}

function setBoxesVisible(v) {
  boxesVisible = v;
  for (const bw of boxWins.values()) bw.setVisible(v && bw.box.visible);
  broadcast();
}

// ---------------------------------------------------------------- traducción

async function start() {
  if (running) return;
  running = true;
  broadcast();
  if (process.platform === 'darwin') {
    const s = systemPreferences.getMediaAccessStatus('screen');
    if (s === 'denied' || s === 'restricted') {
      sendMain('notice', 'Concede el permiso de «Grabación de pantalla» en Ajustes del Sistema → Privacidad y seguridad, y reinicia la app.');
    }
  }
  try { session.defaultSession.preconnect({ url: new URL(ENDPOINT).origin, numSockets: 2 }); } catch { /* opcional */ }
  if (!boxesVisible) setBoxesVisible(true);
  for (const r of runners.values()) r.start();
}

function stop() {
  if (!running) return;
  running = false;
  for (const r of runners.values()) r.stop();
  boxStatus.clear();
  capture.release();
  broadcast();
}

function toggle() { if (running) stop(); else start(); }

// ---------------------------------------------------------------- perfiles

function activateProfile(id, { auto = false } = {}) {
  if (!cfg.profiles.some((p) => p.id === id)) return;
  if (!auto) autoProfile = null;
  if (id === cfg.activeProfileId) return;
  cfg.activeProfileId = id;
  syncBoxWindows();
}

function createProfile(name) {
  const clean = String(name || '').trim().slice(0, 40) || `Perfil ${cfg.profiles.length + 1}`;
  const p = {
    id: config.uid(),
    name: clean,
    app: '',
    boxes: boxes().map((b) => ({ ...b, id: config.uid(), rect: b.rect && { ...b.rect } })),
  };
  cfg.profiles.push(p);
  activateProfile(p.id);
  return p.id;
}

function deleteProfile(id) {
  if (cfg.profiles.length <= 1) return;
  cfg.profiles = cfg.profiles.filter((p) => p.id !== id);
  if (cfg.activeProfileId === id) cfg.activeProfileId = cfg.profiles[0].id;
  syncBoxWindows();
  updateWatcher();
}

function updateProfile(id, patch) {
  const p = cfg.profiles.find((x) => x.id === id);
  if (!p) return;
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 40);
  if (typeof patch.app === 'string') p.app = patch.app.slice(0, 120);
  persist();
  broadcast();
  updateWatcher();
}

// ------------------------------------------- app en primer plano (perfiles)

const SELF = new Set([
  app.getName().toLowerCase(),
  'electron',
  path.basename(process.execPath, path.extname(process.execPath)).toLowerCase(),
]);

function onForeground(name) {
  if (SELF.has(name.toLowerCase())) return;
  const i = recentApps.indexOf(name);
  if (i >= 0) recentApps.splice(i, 1);
  recentApps.unshift(name);
  recentApps.length = Math.min(recentApps.length, 15);

  const match = cfg.profiles.find((p) => p.app && p.app.toLowerCase() === name.toLowerCase());
  if (match) {
    if (match.id !== cfg.activeProfileId) {
      if (!autoProfile) autoProfile = { prev: cfg.activeProfileId };
      activateProfile(match.id, { auto: true });
    }
  } else if (autoProfile) {
    const { prev } = autoProfile;
    autoProfile = null;
    activateProfile(prev, { auto: true });
  }
  broadcast();
}

function updateWatcher() {
  const needed = watchRequested || cfg.profiles.some((p) => p.app);
  if (needed) watcher.start(); else watcher.stop();
}

// ---------------------------------------------------------------- ajustes

function updateSettings(patch) {
  const s = cfg.settings;
  const next = config.sanitize({
    ...cfg,
    settings: { ...s, ...patch, tts: { ...s.tts, ...(patch.tts || {}) } },
  }).settings;
  const ctChanged = next.clickThrough !== s.clickThrough;
  cfg.settings = next;
  if (ctChanged) for (const bw of boxWins.values()) bw.applyClickThrough(next.clickThrough);
  persist();
  broadcast();
}

// ---------------------------------------------------------------- ventanas

function createMainWindow() {
  const b = cfg.mainBounds;
  const onScreen = b && screen.getAllDisplays().some(({ workArea: a }) => (
    b.x >= a.x - 50 && b.y >= a.y - 20 && b.x < a.x + a.width - 100 && b.y < a.y + a.height - 100
  ));
  mainWin = new BrowserWindow({
    width: onScreen ? b.width : 405,
    height: onScreen ? b.height : 720,
    ...(onScreen ? { x: b.x, y: b.y } : {}),
    minWidth: 360,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#0B0D10',
    title: 'Traductor de Pantalla',
    icon: path.join(ROOT, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  mainWin.setAspectRatio(9 / 16);
  mainWin.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.webContents.on('did-finish-load', () => {
    mainReady = true;
    mainQueue.splice(0).forEach(([c, d]) => mainWin.webContents.send(c, d));
  });
  mainWin.webContents.on('did-start-loading', () => { mainReady = false; });

  let t;
  const saveBounds = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized()) return;
      cfg.mainBounds = mainWin.getBounds();
      persist();
    }, 500);
  };
  mainWin.on('move', saveBounds);
  mainWin.on('resize', saveBounds);
  mainWin.on('close', (e) => {
    if (!quitting && cfg.settings.closeToTray && tray && tray.tray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => {
    mainWin = null;
    if (!quitting) quit();
  });
}

function showMain() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function toggleClickThrough() {
  updateSettings({ clickThrough: !cfg.settings.clickThrough });
}

function quit() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- IPC

const fromMain = (fn) => (e, ...args) => {
  if (!mainWin || e.sender !== mainWin.webContents) return undefined;
  return fn(...args);
};
const fromBox = (fn) => (e, ...args) => {
  for (const bw of boxWins.values()) {
    if (bw.alive && bw.win.webContents === e.sender) return fn(bw, ...args);
  }
  return undefined;
};

function registerIpc() {
  ipcMain.handle('app:get-state', fromMain(() => publicState()));
  ipcMain.handle('app:toggle', fromMain(() => { toggle(); return running; }));
  ipcMain.handle('box:add', fromMain(() => addBox()));
  ipcMain.handle('box:remove', fromMain((id) => removeBox(id)));
  ipcMain.handle('box:update', fromMain((id, patch) => updateBox(id, patch || {})));
  ipcMain.handle('boxes:toggle-visible', fromMain(() => setBoxesVisible(!boxesVisible)));
  ipcMain.handle('settings:update', fromMain((patch) => updateSettings(patch || {})));
  ipcMain.handle('profile:create', fromMain((name) => createProfile(name)));
  ipcMain.handle('profile:delete', fromMain((id) => deleteProfile(id)));
  ipcMain.handle('profile:activate', fromMain((id) => activateProfile(id)));
  ipcMain.handle('profile:update', fromMain((id, patch) => updateProfile(id, patch || {})));
  ipcMain.handle('apps:watch', fromMain((on) => { watchRequested = !!on; updateWatcher(); }));
  ipcMain.handle('history:list', fromMain(() => history.list()));
  ipcMain.handle('history:clear', fromMain(() => history.clear()));
  ipcMain.handle('history:export', fromMain(async (format) => {
    const ext = ['txt', 'csv', 'json', 'srt'].includes(format) ? format : 'txt';
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: 'Exportar historial',
      defaultPath: path.join(app.getPath('documents'), `traducciones-${stamp}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (canceled || !filePath) return null;
    const count = await history.export(filePath, ext);
    return { count, filePath };
  }));
  ipcMain.on('win:minimize', fromMain(() => mainWin.minimize()));
  ipcMain.on('win:close', fromMain(() => mainWin.close()));

  ipcMain.on('overlay:set-rect', fromBox((bw, rect) => {
    if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) bw.setRect(rect);
  }));
  ipcMain.on('overlay:interactive', fromBox((bw, on) => bw.setInteractive(!!on)));
  ipcMain.on('overlay:layer-hidden', fromBox((bw, id) => bw.layerHidden(id)));
  ipcMain.on('overlay:select', fromBox((bw) => sendMain('select-box', bw.box.id)));
}

// ---------------------------------------------------------------- arranque

app.whenReady().then(() => {
  if (!gotLock) return;
  store = new JsonFile(path.join(app.getPath('userData'), 'config.json'), {
    defaults: config.defaults,
    sanitize: config.sanitize,
  });
  cfg = store.load();
  store.data = cfg;
  history = new History(path.join(app.getPath('userData'), 'history.json'));
  capture = new Capture();
  ocr = new OcrPool({
    cachePath: path.join(app.getPath('userData'), 'tessdata'),
    bundledPath: app.isPackaged
      ? path.join(process.resourcesPath, 'tessdata')
      : path.join(ROOT, '..', 'build', 'tessdata'),
    onStatus: (text) => sendMain('notice', text),
  });
  watcher = new ForegroundWatcher();
  watcher.on('change', onForeground);

  registerIpc();
  createMainWindow();
  syncBoxWindows();

  tray = new AppTray({
    toggle, showMain, addBox, quit, toggleClickThrough,
    toggleBoxes: () => setBoxesVisible(!boxesVisible),
    activateProfile: (id) => activateProfile(id),
  });
  broadcast();
  updateWatcher();

  // Precarga: OCR latino y ventana de captura listos antes de pulsar el botón
  ocr.warm().then((ok) => { if (!ok) sendMain('notice', 'No se pudo preparar el OCR. Revisa tu conexión: la primera vez descarga los idiomas.'); });
  capture.init().catch(() => {});

  const shortcuts = [
    ['CommandOrControl+Shift+T', toggle],
    ['CommandOrControl+Shift+M', toggleClickThrough],
  ];
  const failed = shortcuts.filter(([acc, fn]) => !globalShortcut.register(acc, fn)).map(([acc]) => acc);
  if (failed.length) sendMain('notice', `Atajo ocupado por otra app: ${failed.join(', ')}`);
});

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher?.stop();
  for (const r of runners.values()) r.stop();
  store?.flush();
  history?.flush();
  capture?.destroy();
  tray?.destroy();
  ocr?.dispose();
});

app.on('window-all-closed', () => {
  // Con la bandeja activa la app sigue viva; si no, se cierra
  if (!tray || !tray.tray) quit();
});

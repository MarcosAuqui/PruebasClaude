const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'state', 'result', 'box-status', 'history:added', 'notice', 'select-box',
  'overlay:state', 'overlay:render', 'overlay:clear', 'overlay:hide-layer', 'overlay:show-layer',
]);

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  on(channel, cb) {
    if (!CHANNELS.has(channel)) throw new Error(`canal no permitido: ${channel}`);
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },

  // Ventana principal
  getState: invoke('app:get-state'),
  toggle: invoke('app:toggle'),
  addBox: invoke('box:add'),
  removeBox: invoke('box:remove'),
  updateBox: invoke('box:update'),
  toggleBoxes: invoke('boxes:toggle-visible'),
  updateSettings: invoke('settings:update'),
  createProfile: invoke('profile:create'),
  deleteProfile: invoke('profile:delete'),
  activateProfile: invoke('profile:activate'),
  updateProfile: invoke('profile:update'),
  watchApps: invoke('apps:watch'),
  historyList: invoke('history:list'),
  historyClear: invoke('history:clear'),
  historyExport: invoke('history:export'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),

  // Recuadro
  overlay: {
    setRect: (r) => ipcRenderer.send('overlay:set-rect', r),
    interactive: (on) => ipcRenderer.send('overlay:interactive', on),
    layerHidden: (id) => ipcRenderer.send('overlay:layer-hidden', id),
    select: () => ipcRenderer.send('overlay:select'),
  },

  // Ventana de captura
  capture: {
    onRequest: (cb) => ipcRenderer.on('capture:req', (_e, msg) => cb(msg)),
    reply: (msg) => ipcRenderer.send('capture:res', msg),
  },
});

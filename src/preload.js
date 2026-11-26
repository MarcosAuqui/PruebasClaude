const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('api', {
  // Ventana principal
  toggle: () => ipcRenderer.invoke('toggle'),
  getState: () => ipcRenderer.invoke('get-state'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  toggleOverlay: () => ipcRenderer.send('overlay:toggle-visible'),
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  onStatus: on('status'),
  onResult: on('result'),
  onState: on('state'),
  onOverlayVisible: on('overlay-visible'),

  // Recuadro
  setBounds: (b) => ipcRenderer.send('overlay:set-bounds', b),
  onOverlayState: on('overlay:state'),
  onCaption: on('overlay:caption'),
});

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

function trayIcon() {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
}

/** Icono en la bandeja del sistema con acceso rápido a todo. */
class AppTray {
  constructor(actions) {
    this.actions = actions;
    this.tray = null;
    try {
      this.tray = new Tray(trayIcon());
      this.tray.setToolTip('Traductor de Pantalla');
      this.tray.on('click', () => actions.showMain());
      this.tray.on('double-click', () => actions.showMain());
    } catch (err) {
      console.warn('Bandeja del sistema no disponible:', err.message);
    }
  }

  update({ running, clickThrough, boxesVisible, profiles, activeProfileId }) {
    if (!this.tray || this.tray.isDestroyed()) return;
    const a = this.actions;
    this.tray.setToolTip(running ? 'Traductor de Pantalla · traduciendo' : 'Traductor de Pantalla');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: running ? 'Finalizar traducción' : 'Iniciar traducción', accelerator: 'CommandOrControl+Shift+T', click: a.toggle },
      { type: 'separator' },
      { label: 'Mostrar ventana', click: a.showMain },
      { label: 'Nuevo recuadro', click: a.addBox },
      { label: boxesVisible ? 'Ocultar recuadros' : 'Mostrar recuadros', click: a.toggleBoxes },
      {
        label: 'Modo atravesable', type: 'checkbox', checked: clickThrough, accelerator: 'CommandOrControl+Shift+M', click: a.toggleClickThrough,
      },
      {
        label: 'Perfil',
        submenu: profiles.map((p) => ({
          label: p.name, type: 'radio', checked: p.id === activeProfileId, click: () => a.activateProfile(p.id),
        })),
      },
      { type: 'separator' },
      { label: 'Salir', click: a.quit },
    ]));
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
  }
}

module.exports = { AppTray };

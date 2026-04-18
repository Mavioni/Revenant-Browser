import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';

export function setupTray(mainWindow: BrowserWindow, iconPath: string): Tray {
  const icon = nativeImage.createFromPath(iconPath);
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Revenant AI',
      click: () => mainWindow.show(),
    },
    {
      label: 'Restart Server',
      click: () => mainWindow.webContents.send('server:restart-requested'),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        (app as any).isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Revenant AI');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow.show();
  });

  return tray;
}

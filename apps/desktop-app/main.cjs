const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

const rendererUrl = process.env.RENDERER_URL || 'http://localhost:5173';

// Some macOS environments can crash GPU subprocesses for dev Electron builds.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#f3ede5',
    title: 'AI 图片压缩工具',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(rendererUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
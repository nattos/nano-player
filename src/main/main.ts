import { app, ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
    width: 940,
    height: 1024,
    titleBarStyle: 'hiddenInset',
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(`http://localhost:4000`);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, './index.html'));
    mainWindow.webContents.openDevTools();
  }
  mainWindow.on('focus', () => { didWindowActiveChange(true); });
  mainWindow.on('blur', () => { didWindowActiveChange(false); });
}

let windowIsActive = false;

function didWindowActiveChange(active: boolean) {
  if (windowIsActive === active) {
    return;
  }
  windowIsActive = active;
  mainWindow.webContents.send('browserWindow.onDidActiveChange', active);
}

ipcMain.handle('browserWindow.active', () => windowIsActive);


app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.whenReady().then(() => {
  createWindow();
})

app.on('window-all-closed', () => {
  app.quit();
})

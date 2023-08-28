import { app, ipcMain, BrowserWindow } from 'electron';
import settings from 'electron-settings';
import * as path from 'path';
import * as utils from '../utils';

interface AppSettings {
  windowWidth?: number;
  windowHeight?: number;
}


let mainWindow: BrowserWindow;
let appSettings: AppSettings;

async function createWindow() {
  appSettings = await settings.get('app-settings') as AppSettings ?? {};

  const windowWidth = appSettings.windowWidth ?? 940;
  const windowHeight = appSettings.windowHeight ?? 1024;

  mainWindow = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
    width: windowWidth,
    height: windowHeight,
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
  mainWindow.on('resize', () => { saveWindowSize(); });
}

let windowIsActive = false;

function didWindowActiveChange(active: boolean) {
  if (windowIsActive === active) {
    return;
  }
  windowIsActive = active;
  mainWindow.webContents.send('browserWindow.onDidActiveChange', active);
}

function saveWindowSize() {
  const windowSize = mainWindow.getSize();
  appSettings.windowWidth = windowSize[0];
  appSettings.windowHeight = windowSize[1];
  // Sync in background.
  settings.set('app-settings', appSettings as {});
}

ipcMain.handle('browserWindow.active', () => windowIsActive);


app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling');
app.whenReady().then(() => {
  createWindow();
})

app.on('window-all-closed', () => {
  app.quit();
})

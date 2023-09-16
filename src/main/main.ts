import { app, dialog, ipcMain, BrowserWindow, shell } from 'electron';
import settings from 'electron-settings';
import * as path from 'path';
import * as utils from '../utils';

interface AppSettings {
  windowWidth?: number;
  windowHeight?: number;
}

interface StyleSettings {
  baseCss?: string;
  detailCss?: string;
}


let mainWindow: BrowserWindow;
let appSettings: AppSettings;
let styleSettings: StyleSettings;

async function createWindow() {
  appSettings = await settings.get('app-settings') as AppSettings ?? {};
  styleSettings = await settings.get('style-settings') as StyleSettings ?? {};

  const windowWidth = appSettings.windowWidth ?? 940;
  const windowHeight = appSettings.windowHeight ?? 1024;

  mainWindow = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      // Custom protocols seem to break media streaming...
      webSecurity: false,
    },
    width: windowWidth,
    height: windowHeight,
    titleBarStyle: 'hiddenInset',
  })

  mainWindow.loadFile(path.join(__dirname, './index.html'));
  if (process.env.NODE_ENV === 'development') {
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
ipcMain.handle('browserWindow.showFileInBrowser', (e, absPath: string) => shell.showItemInFolder(absPath));
ipcMain.handle('browserWindow.showDirectoryPicker', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (canceled) {
    return undefined;
  } else {
    return filePaths[0];
  }
});

ipcMain.handle('browserWindow.getCustomStyles', () => [styleSettings.baseCss, styleSettings.detailCss]);
ipcMain.handle('browserWindow.setCustomStyles', (e, styles: [string|undefined, string|undefined]) => {
  const [baseCss, detailCss] = styles;
  styleSettings.baseCss = baseCss;
  styleSettings.detailCss = detailCss;
  // Sync in background.
  settings.set('style-settings', styleSettings as {});
});

app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling');
app.whenReady().then(() => {
  createWindow();
})

app.on('window-all-closed', () => {
  app.quit();
})

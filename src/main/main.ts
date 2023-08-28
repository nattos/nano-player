import { app, BrowserWindow } from 'electron';
import * as path from 'path';
// import './preload';
// import 'fs';

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    webPreferences: {
      // preload: path.join(__dirname, 'preload.js'),
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
    mainWindow.loadFile(path.join(__dirname, './index.html'))
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

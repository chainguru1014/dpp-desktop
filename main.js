const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const impinj = require('./impinjLlrpMain');

// Which site this window loads — the already-deployed DPP web app by
// default. Everything except the RFID path works identically to opening
// this in a browser; the preload bridge (see preload.js) is what lets the
// app's own impinjRfid.web.ts detect it's running inside this shell and
// switch from calling the backend to calling straight into impinjLlrpMain.js
// below, over a real Node `net` socket to the reader.
const APP_URL = process.env.DPP_DESKTOP_URL || 'https://dpp.innosynch.com';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  impinj.initSettingsPath(app.getPath('userData'));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// One handler per impinjLlrpMain.js export — preload.js calls these by name
// through ipcRenderer.invoke, and impinjRfid.web.ts (the renderer side)
// calls them through the contextBridge-exposed window.electronImpinj, using
// the exact same function names/shapes as the existing backend/native paths.
ipcMain.handle('impinj:getStatus', () => impinj.getStatus());
ipcMain.handle('impinj:connect', () => impinj.connectReader());
ipcMain.handle('impinj:disconnect', () => impinj.disconnectReader());
ipcMain.handle('impinj:start', () => impinj.startReading());
ipcMain.handle('impinj:stop', () => impinj.stopReading());
ipcMain.handle('impinj:getTagsInView', () => impinj.getTagsInView());
ipcMain.handle('impinj:getRecentTags', (event, count) => impinj.getRecentTags(count));
ipcMain.handle('impinj:clearTags', () => impinj.clearTags());
ipcMain.handle('impinj:getSettings', () => impinj.getSettings());
ipcMain.handle('impinj:updateSettings', (event, next) => impinj.updateSettings(next));

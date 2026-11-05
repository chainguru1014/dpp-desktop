const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const impinj = require('./impinjLlrpMain');

// The desktop window shared by both desktop apps: main.js (the DPP app,
// dpp.innosynch.com) and admin-main.js (the DPP Manager admin site). The
// preload bridge (see preload.js) is what lets the site detect it's running
// inside this shell and switch its RFID calls from the backend to
// impinjLlrpMain.js below, over a real Node `net` socket to the reader.
//
// `url`: the site this window loads.
// `openLinksOutside`: when true, links to other websites (a brand's site,
// a document) open in the computer's browser; the site's own pages and the
// Google / Apple sign-in windows stay in the app.
function startShell({ url, openLinksOutside = false }) {
  const siteOrigin = new URL(url).origin;
  const SIGN_IN_HOSTS = ['accounts.google.com', 'appleid.apple.com'];

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
    if (openLinksOutside) {
      win.webContents.setWindowOpenHandler(({ url: target }) => {
        try {
          const { origin, hostname } = new URL(target);
          if (origin === siteOrigin || SIGN_IN_HOSTS.includes(hostname)) return { action: 'allow' };
        } catch (e) {
          return { action: 'deny' };
        }
        shell.openExternal(target);
        return { action: 'deny' };
      });
    }
    win.loadURL(url);
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
  // through ipcRenderer.invoke, and the site (the renderer side) calls them
  // through the contextBridge-exposed window.electronImpinj, using the exact
  // same function names/shapes as the existing backend/native paths.
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
}

module.exports = { startShell };

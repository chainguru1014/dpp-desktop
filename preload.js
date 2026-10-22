// Runs in a special isolated context that has both DOM access and a
// trimmed-down Node API — contextBridge is the only safe way to let the
// (fully web-standard, untrusted-by-default) renderer reach into Electron.
// window.electronImpinj is what app/src/native/impinjRfid.web.ts checks for
// to detect "I'm running inside the desktop shell" and switch from fetching
// the backend to calling straight through to impinjLlrpMain.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronImpinj', {
  getStatus: () => ipcRenderer.invoke('impinj:getStatus'),
  connect: () => ipcRenderer.invoke('impinj:connect'),
  disconnect: () => ipcRenderer.invoke('impinj:disconnect'),
  start: () => ipcRenderer.invoke('impinj:start'),
  stop: () => ipcRenderer.invoke('impinj:stop'),
  getTagsInView: () => ipcRenderer.invoke('impinj:getTagsInView'),
  getRecentTags: (count) => ipcRenderer.invoke('impinj:getRecentTags', count),
  clearTags: () => ipcRenderer.invoke('impinj:clearTags'),
  getSettings: () => ipcRenderer.invoke('impinj:getSettings'),
  updateSettings: (next) => ipcRenderer.invoke('impinj:updateSettings', next),
});

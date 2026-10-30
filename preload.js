const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fitLauncher', {
  getHome: (force = false) => ipcRenderer.invoke('store:getHome', force),
  getNews: (appIds, force = false) => ipcRenderer.invoke('store:getNews', appIds, force),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

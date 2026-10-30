const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fitLauncher', {
  getHome: (force = false) => ipcRenderer.invoke('store:getHome', force),
  getNews: (appIds, force = false) => ipcRenderer.invoke('store:getNews', appIds, force),
  getGame: (appid, force = false) => ipcRenderer.invoke('store:getGame', appid, force),
  searchStore: (term) => ipcRenderer.invoke('store:search', term),
  getFitGirlDownloads: (appid, force = false) =>
    ipcRenderer.invoke('fitgirl:getDownloads', appid, force),
  getCacheInfo: () => ipcRenderer.invoke('settings:getCacheInfo'),
  clearCache: () => ipcRenderer.invoke('settings:clearCache'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

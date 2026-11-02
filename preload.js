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
  getGameDirectory: () => ipcRenderer.invoke('settings:getGameDirectory'),
  chooseGameDirectory: () => ipcRenderer.invoke('settings:chooseGameDirectory'),
  resetGameDirectory: () => ipcRenderer.invoke('settings:resetGameDirectory'),
  openGameDirectory: () => ipcRenderer.invoke('settings:openGameDirectory'),
  startDownloads: (payload) => ipcRenderer.invoke('downloads:start', payload),
  cancelDownloads: (jobId) => ipcRenderer.invoke('downloads:cancel', jobId),
  onDownloadEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('downloads:event', listener);
    return () => ipcRenderer.removeListener('downloads:event', listener);
  },
  openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

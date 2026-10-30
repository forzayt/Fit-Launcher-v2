const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('appInfo', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

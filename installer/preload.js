const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  onMode: (cb) => ipcRenderer.on('mode', (_e, mode) => cb(mode)),
  onProgress: (cb) => ipcRenderer.on('install:progress', (_e, data) => cb(data)),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  defaultDir: () => ipcRenderer.invoke('install:default-dir'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('install:pick-folder', defaultPath),
  diskSpace: (dir) => ipcRenderer.invoke('install:disk-space', dir),
  runInstall: (targetDir) => ipcRenderer.invoke('install:run', targetDir),
  createShortcuts: (targetDir, desktop) => ipcRenderer.invoke('install:shortcuts', targetDir, desktop),
  registerUninstall: (targetDir) => ipcRenderer.invoke('install:register-uninstall', targetDir),
  launch: (targetDir) => ipcRenderer.invoke('install:launch', targetDir),
  findInstall: () => ipcRenderer.invoke('uninstall:find'),
  runUninstall: (dir, wipeData) => ipcRenderer.invoke('uninstall:run', dir, wipeData),
  findUpgradeTarget: () => ipcRenderer.invoke('upgrade:find'),
  runUpgrade: (dir) => ipcRenderer.invoke('upgrade:run', dir),
});

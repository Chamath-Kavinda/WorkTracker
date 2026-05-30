const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadData: () => ipcRenderer.invoke('load-data'),
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowQuit: () => ipcRenderer.invoke('window-quit'),
  
  getPlatformInfo: () => ipcRenderer.invoke('get-platform-info'),
  exportReport: (data) => ipcRenderer.invoke('export-report', data),
  openExportsFolder: () => ipcRenderer.invoke('open-exports-folder'),
  getAppStartTime: () => ipcRenderer.invoke('get-app-start-time'),
});

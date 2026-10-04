/**
 * Ferox Browser - Main Window Preload Script
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('feroxAPI', {
  // Navigation & Tabs
  navigateTab: (tabId, url) => ipcRenderer.send('tab-navigate', { tabId, url }),
  createTab: (url) => ipcRenderer.send('tab-create', { url }),
  closeTab: (tabId) => ipcRenderer.send('tab-close', { tabId }),
  switchTab: (tabId) => ipcRenderer.send('tab-switch', { tabId }),
  goBack: (tabId) => ipcRenderer.send('tab-back', { tabId }),
  goForward: (tabId) => ipcRenderer.send('tab-forward', { tabId }),
  reloadTab: (tabId) => ipcRenderer.send('tab-reload', { tabId }),

  // Shields & Security
  toggleShields: (enabled) => ipcRenderer.send('shields-toggle', { enabled }),
  getShieldsStats: () => ipcRenderer.invoke('shields-get-stats'),
  onShieldsUpdate: (callback) => ipcRenderer.on('shields-update', (_, data) => callback(data)),

  // Browser Window Controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  onWindowMaximized: (callback) => ipcRenderer.on('window-is-maximized', (_, isMaximized) => callback(isMaximized)),

  // Listeners from Main Process
  onTabUpdated: (callback) => ipcRenderer.on('tab-updated', (_, data) => callback(data)),
  onTabCreated: (callback) => ipcRenderer.on('tab-created', (_, data) => callback(data)),
  onTabClosed: (callback) => ipcRenderer.on('tab-closed', (_, data) => callback(data)),
  onOpenInNewTab: (callback) => ipcRenderer.on('open-in-new-tab', (_, data) => callback(data))
});

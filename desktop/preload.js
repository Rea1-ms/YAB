'use strict';

// YAB 桌面壳 preload：暴露环境信息与受限的关窗设置接口。

const { contextBridge, ipcRenderer } = require('electron');

const versions = process.versions || {};

const desktopInfo = {
  isDesktop: true,
  platform: process.platform,
  ...(process.isMainFrame && /^https?:$/.test(location.protocol) ? {
    getCloseAction: () => ipcRenderer.invoke('yab-desktop:close-action:get'),
    setCloseAction: action => ipcRenderer.invoke('yab-desktop:close-action:set', action),
  } : {}),
  versions: {
    electron: versions.electron,
    chrome: versions.chrome,
    node: versions.node,
  },
};
contextBridge.exposeInMainWorld('yabDesktop', desktopInfo);
contextBridge.exposeInMainWorld('baasDesktop', desktopInfo); // Compatibility for existing integrations.

// Only the local startup page receives this read-only bridge. The backend
// webpage and embedded frames have no access to startup logs or local paths.
if (process.isMainFrame && location.protocol === 'file:' && location.pathname.endsWith('/startup.html')) {
  contextBridge.exposeInMainWorld('yabStartup', {
    get: () => ipcRenderer.invoke('yab-startup:get'),
    onUpdate: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('yab-startup:update', listener);
      return () => ipcRenderer.removeListener('yab-startup:update', listener);
    },
  });
}

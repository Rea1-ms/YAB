'use strict';

// YAB 桌面壳 preload：只向页面暴露无害的环境信息。
// 页面（WebUI 前端）本身不需要这些，仅供调试/展示桌面环境信息。

const { contextBridge } = require('electron');

const versions = process.versions || {};

const desktopInfo = {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: versions.electron,
    chrome: versions.chrome,
    node: versions.node,
  },
};
contextBridge.exposeInMainWorld('yabDesktop', desktopInfo);
contextBridge.exposeInMainWorld('baasDesktop', desktopInfo); // Compatibility for existing integrations.

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const channel = process.argv.find(value => value.startsWith('--yab-message-channel='))?.split('=')[1];
contextBridge.exposeInMainWorld('yabMessage', {
  get: () => ipcRenderer.invoke(channel, 'get'),
  respond: value => ipcRenderer.invoke(channel, 'respond', value),
});

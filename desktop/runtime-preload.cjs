'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (method, value) => {
  const result = await ipcRenderer.invoke('yab-runtime:' + method, value);
  if (result.error) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('runtimeSettings', {
  get: () => invoke('get'), detect: () => invoke('detect'), browse: () => invoke('browse'),
  inspect: value => invoke('inspect', value),
  save: value => invoke('save', value),
});

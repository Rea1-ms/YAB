'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, dialog } = require('electron');
const { INDEXES, loadRuntimeSettings, saveRuntimeSettings, checkUv, findSystemUv, resolveUv } = require('./runtime-settings.cjs');

let current;

function openRuntimeWindow({ parent, configRoot, userData, bundle, bundled, initial = false, show = true }) {
  if (current) { current.window.show(); current.window.focus(); return current.result; }
  const window = new BrowserWindow({ width: 720, height: 640, minWidth: 580, minHeight: 600,
    parent, modal: Boolean(parent), show: false, autoHideMenuBar: true, title: '运行环境',
    backgroundColor: '#0f1115', webPreferences: { contextIsolation: true, nodeIntegration: false,
      sandbox: true, preload: path.join(__dirname, 'runtime-preload.cjs') } });
  let saved = null;
  const channels = [];
  const handle = (name, action) => {
    const channel = 'yab-runtime:' + name;
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的设置请求');
      try { return { value: await action(...args) }; } catch (error) { return { error: error.message }; }
    });
  };
  handle('get', async () => {
    let model;
    try { model = await loadRuntimeSettings(configRoot, userData, bundled); }
    catch (error) { model = { settings: { uvMode: bundled ? 'bundled' : 'system', uvPath: '', index: 'pypi' }, warning: error.message }; }
    return { ...model, indexes: INDEXES, bundled, initial };
  });
  handle('detect', findSystemUv);
  handle('inspect', value => {
    if (value?.uvMode === 'system') return findSystemUv();
    if (value?.uvMode === 'bundled' && bundled) return checkUv(path.join(bundle, 'toolkit/uv.exe'));
    if (value?.uvMode === 'custom' && typeof value.uvPath === 'string') return checkUv(value.uvPath);
    throw new Error('请选择有效的工具来源');
  });
  handle('browse', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择依赖管理工具', properties: ['openFile'],
      filters: [{ name: 'uv（依赖管理工具）', extensions: ['exe'] }] });
    return result.canceled ? null : checkUv(result.filePaths[0]);
  });
  handle('save', async value => {
    await resolveUv(value, path.join(bundle, 'toolkit/uv.exe'));
    saved = await saveRuntimeSettings(configRoot, userData, value);
    setImmediate(() => window.close());
    return true;
  });
  const result = new Promise(resolve => window.once('closed', () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
    current = null;
    resolve(saved);
  }));
  current = { window, result };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (show) window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, 'runtime-settings.html'));
  return result;
}

module.exports = { openRuntimeWindow };

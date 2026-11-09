'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
let sequence = 0;

function showMessage(parent, options = {}, { show = true } = {}) {
  const buttons = options.buttons?.length ? options.buttons.map(String) : ['确定'];
  const defaultId = Math.max(0, Math.min(options.defaultId ?? 0, buttons.length - 1));
  const cancelId = Math.max(0, Math.min(options.cancelId ?? buttons.length - 1, buttons.length - 1));
  const channel = `yab-message:${++sequence}`;
  const owner = parent && !parent.isDestroyed() ? parent : undefined;
  const window = new BrowserWindow({ width: 520, height: 320, minWidth: 400, minHeight: 260,
    parent: owner, modal: Boolean(owner), show: false, autoHideMenuBar: true, minimizable: false,
    maximizable: false, title: options.title || 'YAB', backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'message-preload.cjs'), additionalArguments: [`--yab-message-channel=${channel}`] } });
  let response = cancelId;
  ipcMain.handle(channel, (event, action, value) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的消息请求');
    if (action === 'get') return { message: String(options.message || ''), detail: String(options.detail || ''),
      buttons, defaultId, cancelId };
    if (action !== 'respond' || !Number.isInteger(value) || value < 0 || value >= buttons.length) throw new Error('无效的按钮');
    response = value;
    setImmediate(() => window.close());
    return true;
  });
  const result = new Promise(resolve => window.once('closed', () => {
    ipcMain.removeHandler(channel);
    resolve({ response });
  }));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'message.html')).catch(() => window.close());
  if (show) window.once('ready-to-show', () => window.show());
  return result;
}

module.exports = { showMessage };

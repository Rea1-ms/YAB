'use strict';

const { EventEmitter } = require('events');
const { stripVTControlCharacters } = require('util');
const { pathToFileURL } = require('url');
const path = require('path');

const STARTUP_PAGE = pathToFileURL(path.join(__dirname, 'startup.html')).href;
const GET_CHANNEL = 'yab-startup:get';
const UPDATE_CHANNEL = 'yab-startup:update';

class StartupProgress extends EventEmitter {
  constructor() {
    super();
    this.state = { revision: 0, percent: 0, message: '正在启动 YAB…', status: 'running',
      startedAt: Date.now(), lastOutputAt: null, logText: '', environment: '' };
  }

  snapshot() { return { ...this.state }; }

  changed() { this.state.revision++; this.emit('change'); }

  append(chunk) {
    if (this.state.status === 'complete') return;
    const text = stripVTControlCharacters(String(chunk)).replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (!text) return;
    // Keep partial lines, but bound both long lines and many short lines.
    this.state.logText = (this.state.logText + text).slice(-120000).split('\n').slice(-500).join('\n');
    this.state.lastOutputAt = Date.now();
    this.changed();
  }

  report(message, percent = this.state.percent) {
    if (this.state.status === 'complete') return;
    const changed = this.state.message !== message;
    this.state.message = message;
    this.state.status = 'running';
    if (Number.isFinite(percent)) this.state.percent = Math.max(this.state.percent, Math.min(99, Math.max(0, percent)));
    if (changed) this.append(`\n[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}\n`);
    else this.changed();
  }

  setEnvironment(directory) {
    this.state.environment = directory;
    this.append(`运行环境：${directory}\n`);
  }

  fail(message) {
    if (this.state.status === 'complete') return;
    this.state.status = 'failed';
    this.state.message = '启动失败';
    this.append(`\n启动失败：${message}\n`);
  }

  complete() {
    this.state.percent = 100;
    this.state.status = 'complete';
    this.state.message = '启动完成';
    this.changed();
  }
}

function attachStartupProgress(window, progress, ipcMain, contents = window.webContents) {
  const isStartupPage = () => !contents.isDestroyed() && contents.getURL() === STARTUP_PAGE;
  ipcMain.handle(GET_CHANNEL, event => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !isStartupPage()) {
      throw new Error('无效的启动状态请求');
    }
    return progress.snapshot();
  });
  let timer;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (isStartupPage()) contents.send(UPDATE_CHANNEL, progress.snapshot());
    if (!window.isDestroyed()) window.setProgressBar(progress.state.status === 'complete' ? -1 : progress.state.percent / 100,
      { mode: progress.state.status === 'failed' ? 'error' : 'normal' });
  };
  const schedule = () => {
    if (progress.state.status !== 'running') flush();
    else if (!timer) timer = setTimeout(flush, 60);
  };
  progress.on('change', schedule);
  contents.on('did-finish-load', flush);
  const detach = () => {
    clearTimeout(timer);
    progress.off('change', schedule);
    contents.removeListener('did-finish-load', flush);
    ipcMain.removeHandler(GET_CHANNEL);
    window.removeListener('closed', detach);
  };
  window.once('closed', detach);
  return detach;
}

async function createStartupScreen(window, progress, ipcMain) {
  const { WebContentsView } = require('electron');
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, backgroundThrottling: false, transparent: true,
  } });
  // Keep the startup page above the application while it loads. Its transparent
  // surface lets the final fade reveal the ready page without a blank frame.
  view.setBackgroundColor('#00000000');
  window.contentView.addChildView(view);
  const resize = () => {
    const { width, height } = window.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  resize();
  window.on('resize', resize);
  const detach = attachStartupProgress(window, progress, ipcMain, view.webContents);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    detach();
    window.removeListener('resize', resize);
    window.removeListener('closed', dispose);
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };
  window.once('closed', dispose);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', event => event.preventDefault());
  try { await view.webContents.loadFile(path.join(__dirname, 'startup.html')); }
  catch (error) { dispose(); throw error; }
  return {
    webContents: view.webContents,
    async finish() {
      if (disposed) return;
      progress.complete();
      let timeout;
      try {
        // The animation is cosmetic: a stopped renderer must not prevent entry.
        await Promise.race([
          view.webContents.executeJavaScript('window.finishStartupTransition()'),
          new Promise(resolve => { timeout = setTimeout(resolve, 1200); }),
        ]);
      } catch { /* Reveal the loaded application if animation is unavailable. */ }
      finally { clearTimeout(timeout); dispose(); }
    },
  };
}

module.exports = { StartupProgress, attachStartupProgress, createStartupScreen, STARTUP_PAGE };

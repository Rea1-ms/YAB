'use strict';

const fs = require('fs');
const path = require('path');

const CLOSE_ACTIONS = ['仅关闭窗口', '开启轻量模式', '询问'];

function readWindowMode(filename) {
  if (!fs.existsSync(filename)) return '询问';
  const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!settings || !CLOSE_ACTIONS.includes(settings.closeAction)) throw new Error('关闭窗口设置不合法');
  return settings.closeAction;
}

function saveWindowMode(filename, closeAction) {
  if (!CLOSE_ACTIONS.includes(closeAction)) throw new Error('关闭窗口设置不合法');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify({ closeAction }, null, 2) + String.fromCharCode(10));
}

function attachWindowSettings(ipcMain, { mode, filename, getWindow, pageUrl }) {
  const check = event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame
        || new URL(event.sender.getURL()).origin !== new URL(pageUrl()).origin) {
      throw new Error('无效的桌面设置请求');
    }
  };
  ipcMain.handle('yab-desktop:close-action:get', event => { check(event); return mode.closeAction; });
  ipcMain.handle('yab-desktop:close-action:set', (event, action) => {
    check(event);
    saveWindowMode(filename, action);
    mode.closeAction = action;
    return action;
  });
}

class WindowMemoryMode {
  constructor({ canRelease, isQuitting = () => false, onHidden = () => {}, ask, save = () => {}, onError = () => {} }) {
    this.canRelease = canRelease;
    this.isQuitting = isQuitting;
    this.onHidden = onHidden;
    this.closeAction = '询问';
    this.ask = ask;
    this.save = save;
    this.onError = onError;
    this.closing = false;
    this.window = null;
    this.state = null;
    this.restoredBounds = null;
    this.opening = null;
  }

  attach(window) {
    this.window = window;
    // Native frame rounding must not accumulate across repeated restores.
    // These events distinguish user moves/resizes from our initial setBounds.
    const forgetBounds = () => { this.restoredBounds = null; };
    window.on('will-move', forgetBounds);
    window.on('will-resize', forgetBounds);
    window.on('close', event => {
      if (this.isQuitting()) return;
      event.preventDefault();
      void this.requestClose(window).catch(error => this.onError(error));
    });
    window.once('closed', () => {
      if (this.window === window) {
        this.window = null;
        this.restoredBounds = null;
      }
    });
  }

  async requestClose(window) {
    if (this.closing || !window || window.isDestroyed()) return;
    this.closing = true;
    try {
      if (!this.canRelease()) { this.hide(window, false); return; }
      let action = this.closeAction;
      if (action === '询问') {
        const result = await this.ask(window);
        if (result.response > 1 || this.isQuitting() || window.isDestroyed()) return;
        action = result.response === 0 ? '开启轻量模式' : '仅关闭窗口';
        if (result.checkboxChecked) {
          this.save(action);
          this.closeAction = action;
        }
      }
      this.hide(window, action === '开启轻量模式');
    } finally { this.closing = false; }
  }

  hide(window = this.window, release = this.closeAction === '开启轻量模式') {
    if (!window || window.isDestroyed()) return;
    const released = release && this.canRelease();
    if (released) {
      this.state = {
        bounds: this.restoredBounds || (window.isMaximized() || window.isMinimized() || window.isFullScreen()
          ? window.getNormalBounds() : window.getBounds()),
        maximized: window.isMaximized(),
        fullscreen: window.isFullScreen(),
        url: window.webContents.getURL() || this.state?.url,
      };
      // Destroying the window releases its renderer; hiding alone retains the page.
      window.destroy();
    } else {
      window.hide();
    }
    this.onHidden(released);
  }

  pageUrl(fallback) {
    try {
      const saved = new URL(this.state?.url);
      if (saved.origin === new URL(fallback).origin) return saved.href;
    } catch { /* No saved page yet. */ }
    return fallback;
  }

  async show(createWindow) {
    if (this.opening) return this.opening;
    const reveal = window => {
      if (this.isQuitting() || window.isDestroyed()) return null;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return window;
    };
    if (this.window && !this.window.isDestroyed()) return reveal(this.window);
    // Coalesce rapid tray clicks while the replacement page is still loading.
    this.opening = (async () => {
      const window = await createWindow(this.state);
      if (this.isQuitting() || window.isDestroyed()) return null;
      if (this.state?.bounds) {
        window.setBounds(this.state.bounds);
        this.restoredBounds = this.state.bounds;
      }
      if (this.state?.maximized) window.maximize();
      if (this.state?.fullscreen) window.setFullScreen(true);
      return reveal(window);
    })();
    try { return await this.opening; }
    finally { this.opening = null; }
  }
}

module.exports = { WindowMemoryMode, readWindowMode, saveWindowMode, attachWindowSettings };

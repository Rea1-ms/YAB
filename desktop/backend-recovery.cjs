'use strict';

// Restore the service after a process crash, leaving every task stopped.
class BackendRecovery {
  constructor({ restart, isQuitting = () => false, log = () => {} }) {
    this.restart = restart;
    this.isQuitting = isQuitting;
    this.log = log;
    this.state = { revision: 0, generation: 0, recovering: false, logs: [] };
    this.listeners = new Set();
    this.pending = null;
  }

  snapshot() { return structuredClone(this.state); }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  report(message, level = 3) {
    this.log(message);
    this.state.logs.push({ l: level, m: message, t: Date.now() / 1000 });
    this.state.logs = this.state.logs.slice(-100);
    this.state.revision++;
    for (const listener of this.listeners) listener(this.snapshot());
  }

  recover(exit, tail) {
    if (this.isQuitting()) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      if (this.isQuitting()) return;
      this.state.generation++;
      this.state.recovering = true;
      this.report(`后端进程意外退出（退出码=${exit.code}，信号=${exit.signal ?? '无'}）。所有任务已停止，正在恢复服务。\n${tail}`);
      try {
        await this.restart();
        if (this.isQuitting()) return;
        this.state.recovering = false;
        this.report('后端服务已恢复，任务保持停止，请手动启动所需配置。', 2);
      } catch (error) {
        if (this.isQuitting()) return;
        this.state.recovering = false;
        this.report(`后端服务恢复失败，任务保持停止。请重新启动应用。\n${error.message}`);
      }
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

function attachBackendRecovery(ipcMain, { recovery, getWindow, pageUrl }) {
  const authorized = window => {
    try { return window && !window.isDestroyed()
      && new URL(window.webContents.getURL()).origin === new URL(pageUrl()).origin; }
    catch { return false; }
  };
  ipcMain.handle('yab-backend:get', event => {
    const window = getWindow();
    if (!authorized(window) || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的后端状态请求');
    return recovery.snapshot();
  });
  recovery.subscribe(state => {
    const window = getWindow();
    if (authorized(window)) window.webContents.send('yab-backend:update', state);
  });
}

module.exports = { BackendRecovery, attachBackendRecovery };

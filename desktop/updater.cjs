'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { installerName } = require('./update-config.cjs');

const AUTO_CHECK_COOLDOWN = 30000;
const USER_ERRORS = new Set([
  '未能读取更新清单', '更新清单与当前发行类型不匹配，或缺少文件校验值',
  '后端尚未就绪，请稍后重试', '请先关闭其他设置窗口再安装更新',
  '任务尚未停止，已取消安装，请稍后重试', '应用正在退出', '更新状态响应过大',
  '更新准备请求失败', '更新准备请求超时', '安装器未能启动，已取消退出',
]);

// Updater exceptions may contain response headers, cookies and signed URLs.
// Only bounded, local messages cross the renderer bridge.
function updateErrorMessage(error, operation) {
  const message = String(error?.message || error);
  const code = String(error?.code || '');
  if (USER_ERRORS.has(message)) return message;
  if (code === 'YAB_INSTALLER_NOT_FOUND') return '安装器未能启动，请重试';
  if (code === 'ENOSPC') return '磁盘空间不足，请清理后重试';
  if (code === 'EACCES' || code === 'EPERM') return '无法写入更新文件，请检查目录权限';
  if (/checksum|sha512|digest mismatch/i.test(message) || code === 'ERR_CHECKSUM_MISMATCH') {
    return '更新包校验失败，请重新下载';
  }
  const status = Number(error?.statusCode || error?.status
    || message.match(/(?:HttpError:|HTTP(?:\s+status)?|status(?:Code)?[=:]?)\s*(\d{3})\b/i)?.[1]);
  if (status === 403 || status === 429) return '更新服务暂时受限，请稍后重试';
  if (status === 404 || (!status && code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')) {
    return operation === 'checking' ? '暂未找到当前发行包的更新信息' : '更新包暂不可用，请稍后重试';
  }
  if (/^E(CONN|HOST|NET|AI_|NOTFOUND|TIMEDOUT)|^ERR_(CONNECTION|NETWORK|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|TIMED_OUT)/.test(code)
      || /net::ERR_|timed?\s*out|network error/i.test(message)) return '无法连接更新服务器，请稍后重试';
  if (operation === 'checking') return '检查更新失败，请稍后重试';
  if (operation === 'downloading') return '下载更新失败，请稍后重试';
  return '安装未完成，请重试';
}

function validateSchedule(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.time !== 'string'
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw new Error('定时检查设置不合法');
  return { enabled: value.enabled, time: value.time };
}

class DesktopUpdater {
  constructor({ updater, version, config, disabledReason = '', prepare, resume = async () => {}, journal,
    settingsFile, clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.updater = updater;
    this.config = config;
    this.prepare = prepare;
    this.resume = resume;
    this.journal = journal;
    this.clock = clock;
    this.lastCheckAt = null;
    this.settingsFile = settingsFile;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.scheduleTimer = null;
    this.automaticStarted = false;
    this.scheduleWrite = Promise.resolve();
    this.listeners = new Set();
    this.pending = null;
    this.info = null;
    this.state = { revision: 0, enabled: !disabledReason, reason: disabledReason, phase: 'idle',
      currentVersion: version, latestVersion: '', variant: config.variant,
      percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, notes: '', error: '', lastResult: '',
      schedule: { enabled: false, time: '08:00' } };
    if (!updater || disabledReason) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on('download-progress', progress => {
      if (this.state.phase !== 'downloading') return;
      this.set({ percent: Math.max(0, Math.min(100, progress.percent || 0)),
        transferred: progress.transferred || 0, total: progress.total || 0, bytesPerSecond: progress.bytesPerSecond || 0 });
    });
    // 事件必须监听，下载、查询的拒绝由各自操作处理；安装器异步启动错误需恢复后端。
    updater.on('error', error => {
      if (this.state.phase === 'installing') void this.installFailed(error);
    });
  }

  snapshot() { return structuredClone(this.state); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  set(patch) {
    Object.assign(this.state, patch, { revision: this.state.revision + 1 });
    for (const listener of this.listeners) listener(this.snapshot());
    return this.snapshot();
  }
  failure(error, phase = 'error') { return this.set({ phase, error: updateErrorMessage(error, this.state.phase) }); }
  assertEnabled() { if (!this.state.enabled || !this.updater) throw new Error(this.state.reason || '桌面更新不可用'); }

  async loadSchedule() {
    if (!this.state.enabled || !this.settingsFile) return this.snapshot();
    try {
      const schedule = validateSchedule(JSON.parse(await fs.readFile(this.settingsFile, 'utf8')));
      return this.set({ schedule });
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[更新] 无法读取定时更新设置，使用默认值');
      return this.snapshot();
    }
  }

  async setSchedule(value) {
    this.assertEnabled();
    const schedule = validateSchedule(value);
    this.scheduleWrite = this.scheduleWrite.catch(() => {}).then(async () => {
      if (this.settingsFile) await writeRecord(this.settingsFile, schedule);
      this.set({ schedule });
      this.armSchedule();
      return this.snapshot();
    });
    return this.scheduleWrite;
  }

  startAutoChecks() {
    if (!this.state.enabled || !this.updater || this.automaticStarted) return Promise.resolve(this.snapshot());
    this.automaticStarted = true;
    this.armSchedule();
    return this.check({ automatic: true });
  }

  stopAutoChecks() {
    this.automaticStarted = false;
    if (this.scheduleTimer !== null) this.clearTimer(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  armSchedule() {
    if (this.scheduleTimer !== null) this.clearTimer(this.scheduleTimer);
    this.scheduleTimer = null;
    if (!this.automaticStarted || !this.state.schedule.enabled) return;
    const now = this.clock();
    const next = new Date(now);
    const [hour, minute] = this.state.schedule.time.split(':').map(Number);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    this.scheduleTimer = this.setTimer(() => {
      this.scheduleTimer = null;
      if (!this.automaticStarted) return;
      void this.check({ automatic: true }).catch(() => {});
      this.armSchedule();
    }, next.getTime() - now);
    this.scheduleTimer?.unref?.();
  }

  async check({ automatic = false } = {}) {
    this.assertEnabled();
    if (this.pending || ['downloading', 'downloaded', 'preparing', 'installing'].includes(this.state.phase)) return this.snapshot();
    const now = this.clock();
    if (automatic && this.lastCheckAt !== null && now >= this.lastCheckAt
        && now - this.lastCheckAt < AUTO_CHECK_COOLDOWN) return this.snapshot();
    this.lastCheckAt = now;
    this.set({ phase: 'checking', error: '', percent: 0, latestVersion: '', notes: '' });
    this.pending = (async () => {
      try {
        let available = false;
        const onAvailable = () => { available = true; };
        this.updater.once('update-available', onAvailable);
        let result;
        try { result = await this.updater.checkForUpdates(); }
        finally { this.updater.removeListener('update-available', onAvailable); }
        if (!result) throw new Error('未能读取更新清单');
        if (!available) { this.info = null; return this.set({ phase: 'current', latestVersion: '', notes: '' }); }
        const info = result.updateInfo;
        const expected = installerName(info.version, this.config.variant);
        const executableFiles = (info.files || []).filter(file => new URL(file.url, this.config.url).pathname.endsWith('.exe'));
        if (executableFiles.length !== 1 || decodeURIComponent(new URL(executableFiles[0].url, this.config.url).pathname.split('/').pop()) !== expected
            || Buffer.from(executableFiles[0].sha512 || '', 'base64').length !== 64) {
          throw new Error('更新清单与当前发行类型不匹配，或缺少文件校验值');
        }
        this.info = info;
        const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes
          : Array.isArray(info.releaseNotes) ? info.releaseNotes.map(item => item.note || '').join('\n') : '';
        return this.set({ phase: 'available', latestVersion: info.version, notes: notes.slice(0, 20000) });
      } catch (error) { this.info = null; return this.failure(error); }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async download() {
    this.assertEnabled();
    if (this.pending) return this.snapshot();
    if (!this.info || !['available', 'error'].includes(this.state.phase)) throw new Error('请先检查可用更新');
    this.set({ phase: 'downloading', error: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    this.pending = (async () => {
      try {
        await this.updater.downloadUpdate();
        return this.set({ phase: 'downloaded', percent: 100 });
      } catch (error) { return this.failure(error); }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async install() {
    this.assertEnabled();
    if (this.pending || this.state.phase !== 'downloaded') throw new Error('请先下载更新');
    this.set({ phase: 'preparing', error: '' });
    this.pending = (async () => {
      try {
        await this.prepare(this.state.latestVersion);
        this.set({ phase: 'installing' });
        this.updater.quitAndInstall(true, true);
        return this.snapshot();
      } catch (error) { return this.installFailed(error); }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async installFailed(error) {
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      this.failure(error, 'preparing');
      try { await this.resume(); }
      catch { this.set({ error: '恢复服务失败，请重启程序后重试' }); }
      return this.set({ phase: 'downloaded' });
    })();
    try { return await this.recovering; } finally { this.recovering = null; }
  }

  async confirmStartup(backendVersion) {
    if (!this.journal) return;
    let record;
    try { record = JSON.parse(await fs.readFile(this.journal, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; this.set({ lastResult: '无法读取上次更新记录' }); return; }
    if (record.status !== 'pending') return;
    const success = record.targetVersion === this.state.currentVersion && backendVersion === record.targetVersion;
    const message = success ? '更新完成' : '上次更新未完成，当前程序与目标版本不一致';
    await writeRecord(this.journal, { ...record, status: success ? 'complete' : 'failed', message });
    this.set({ lastResult: message });
  }
}

// electron-updater 6.8 的安装启动是异步的，默认会立即退出。
// 等待系统确认安装器已启动，再允许退出；启动失败时保留窗口供恢复和重试。
function createNsisUpdater(config, spawn = require('node:child_process').spawn) {
  const { NsisUpdater } = require('electron-updater');
  const updater = new NsisUpdater({ provider: 'generic', url: config.url,
    channel: config.channel, useMultipleRangeRequest: false });
  guardInstallerLaunch(updater, spawn);
  return updater;
}

function guardInstallerLaunch(updater, spawn) {
  const launches = new Set();
  let failed = false;
  let confirmed = false;
  const quit = updater.app.quit.bind(updater.app);
  const install = updater.quitAndInstall.bind(updater);
  updater.quitAndInstall = (...args) => { failed = false; confirmed = false; return install(...args); };
  updater.on('error', () => {
    failed = true;
    updater.quitAndInstallCalled = false;
  });
  updater.spawnLog = (command, args = [], env, stdio = 'ignore') => {
    const pending = new Promise((resolve, reject) => {
      try {
        const child = spawn(command, args, { env, stdio, detached: true, windowsHide: true });
        child.once('error', error => {
          // NsisUpdater 对 ENOENT 会尝试 shell.openPath；其失败返回的是字符串，
          // 无法保证触发 error。不存在的安装器直接报错，保留当前程序。
          if (error.code === 'ENOENT') error.code = 'YAB_INSTALLER_NOT_FOUND';
          reject(error);
        });
        child.once('spawn', () => { confirmed = true; child.unref(); resolve(true); });
      } catch (error) { reject(error); }
    });
    launches.add(pending);
    void pending.then(() => launches.delete(pending), () => launches.delete(pending));
    return pending;
  };
  updater.app.quit = async () => {
    // 提权重试可能在前一次启动失败后新建另一个进程。
    do { await Promise.allSettled([...launches]); await Promise.resolve(); } while (launches.size);
    if (!failed && confirmed) quit();
    else if (!failed) updater.emit('error', new Error('安装器未能启动，已取消退出'));
  };
}

async function writeRecord(filename, record) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const pending = `${filename}.${randomUUID()}.pending`;
  await fs.writeFile(pending, JSON.stringify(record, null, 2));
  await fs.rename(pending, filename);
}

function attachDesktopUpdater(ipcMain, { controller, getWindow, pageUrl }) {
  const authorized = (event, window) => {
    try { return window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame
      && new URL(event.senderFrame.url || window.webContents.getURL()).origin === new URL(pageUrl()).origin
      && new URL(window.webContents.getURL()).origin === new URL(pageUrl()).origin; }
    catch { return false; }
  };
  for (const action of ['get', 'check', 'download', 'install', 'schedule']) {
    ipcMain.handle(`yab-update:${action}`, (event, options) => {
      if (!authorized(event, getWindow())) throw new Error('无效的桌面更新请求');
      if (action === 'check') return controller.check({ automatic: options?.automatic === true });
      if (action === 'schedule') return controller.setSchedule(options);
      return action === 'get' ? controller.snapshot() : controller[action]();
    });
  }
  controller.subscribe(state => {
    const window = getWindow();
    if (window && authorized({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window)) {
      window.webContents.send('yab-update:state', state);
    }
  });
}

module.exports = { DesktopUpdater, attachDesktopUpdater, writeRecord, createNsisUpdater, guardInstallerLaunch };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DesktopUpdater, attachDesktopUpdater, writeRecord, guardInstallerLaunch } = require('../updater.cjs');
const { updateConfig, installerName, installedAt, createUpdateManifest, RELEASE_URL, VARIANTS } = require('../update-config.cjs');
const newTestDirectory = require('./output.cjs').testDirectories(['result.json']);
const { prepareBuildInput } = require('../build-inputs.cjs');

const digest = Buffer.alloc(64, 5).toString('base64');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0;
  let installs = 0;
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit('update-available');
    return { updateInfo: { version: '0.0.2', files: [{ url: installerName('0.0.2', 'offline'), sha512: digest }] } };
  };
  updater.downloadUpdate = async () => ['fixture.exe'];
  updater.quitAndInstall = () => { installs++; };
  const controller = new DesktopUpdater({ updater, version: '0.0.1', config: updateConfig(), prepare: async () => {}, ...options });
  return { updater, controller, checks: () => checks, installs: () => installs };
}

test('downloading and installation require explicit actions, with no installation on ordinary quit', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, false);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.disableWebInstaller, true);
  const checking = f.controller.check();
  await f.controller.check();
  assert.equal(f.checks(), 1);
  assert.equal((await checking).phase, 'available');
  assert.equal(f.installs(), 0);
  assert.equal((await f.controller.download()).phase, 'downloaded');
  assert.equal(f.installs(), 0);
  assert.equal((await f.controller.install()).phase, 'installing');
  assert.equal(f.installs(), 1);
});

test('three release variants reject cross-variant manifests before download', async () => {
  for (const variant of VARIANTS) {
    const f = fixture({ config: updateConfig(variant) });
    const result = await f.controller.check();
    assert.equal(result.phase, variant === 'offline' ? 'available' : 'error');
    if (variant !== 'offline') assert.match(result.error, /发行类型/);
  }
});

test('network failures and missing digests never report the latest version, and download can retry', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => { throw new Error('feed unavailable'); };
  assert.equal((await f.controller.check()).phase, 'error');
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available');
    return { updateInfo: { version: '0.0.2', files: [{ url: installerName('0.0.2', 'offline'), sha512: 'invalid' }] } };
  };
  assert.equal((await f.controller.check()).phase, 'error');
  f.updater.checkForUpdates = async () => { f.updater.emit('update-not-available'); return { updateInfo: { version: '0.0.1' } }; };
  assert.equal((await f.controller.check()).phase, 'current');
  const retry = fixture();
  await retry.controller.check();
  retry.updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  assert.equal((await retry.controller.download()).error, '更新包校验失败，请重新下载');
  retry.updater.downloadUpdate = async () => ['fixture.exe'];
  assert.equal((await retry.controller.download()).phase, 'downloaded');
});

test('every startup checks, while automatic page checks coalesce and manual retries bypass the cooldown', async () => {
  let now = new Date(2026, 10, 15, 7).getTime();
  const f = fixture({ clock: () => now });
  await f.controller.startAutoChecks();
  await f.controller.startAutoChecks();
  await f.controller.check({ automatic: true });
  assert.equal(f.checks(), 1);
  now += 30000;
  await f.controller.check({ automatic: true });
  assert.equal(f.checks(), 2);
  await f.controller.check();
  assert.equal(f.checks(), 3);
  const restarted = fixture({ clock: () => now });
  await restarted.controller.startAutoChecks();
  assert.equal(restarted.checks(), 1, 'Restarting the same day is not suppressed');
  assert.equal(f.installs(), 0);
  assert.equal(restarted.installs(), 0);
  f.controller.stopAutoChecks(); restarted.controller.stopAutoChecks();
});

test('startup and page checks share one pending network operation', async () => {
  let release;
  let checks = 0;
  const f = fixture();
  f.updater.checkForUpdates = async () => {
    checks++;
    await new Promise(resolve => { release = resolve; });
    return { updateInfo: { version: '0.0.1' } };
  };
  const startup = f.controller.startAutoChecks();
  await f.controller.check({ automatic: true });
  await f.controller.check();
  assert.equal(checks, 1);
  release();
  assert.equal((await startup).phase, 'current');
  f.controller.stopAutoChecks();
});

test('optional local-time schedule persists, re-arms daily and skips downloaded updates', async () => {
  const scratch = await newTestDirectory('update-schedule-');
  const settingsFile = path.join(scratch, 'config', 'desktop-update.json');
  let now = new Date(2026, 10, 15, 7).getTime();
  const timers = [];
  const f = fixture({ settingsFile, clock: () => now,
    setTimer: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; } });
  await f.controller.loadSchedule();
  assert.deepEqual(f.controller.snapshot().schedule, { enabled: false, time: '08:00' });
  await f.controller.startAutoChecks();
  assert.equal(timers.length, 0);
  const schedule = { enabled: true, time: '08:00' };
  await f.controller.setSchedule(schedule);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')), schedule);
  assert.equal(timers.at(-1).delay, 3600000);
  const loaded = fixture({ settingsFile });
  await loaded.controller.loadSchedule();
  assert.deepEqual(loaded.controller.snapshot().schedule, schedule);
  assert.equal(loaded.checks(), 0);
  for (const invalid of [{ enabled: true, time: '24:00' }, { enabled: true, time: '08:60' }, { enabled: 'yes', time: '08:00' }]) {
    await assert.rejects(f.controller.setSchedule(invalid), /不合法/);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')), schedule);
  now = new Date(2026, 10, 15, 8).getTime();
  timers.at(-1).callback(); await tick();
  assert.equal(f.checks(), 2);
  assert.equal(timers.at(-1).delay, new Date(2026, 10, 16, 8).getTime() - now);
  await f.controller.download();
  now = new Date(2026, 10, 16, 8).getTime();
  timers.at(-1).callback(); await tick();
  assert.equal(f.checks(), 2);
  assert.equal(f.controller.snapshot().phase, 'downloaded');
  const activeTimer = timers.at(-1);
  await f.controller.setSchedule({ enabled: false, time: '09:45' });
  assert.equal(activeTimer.cleared, true);
  assert.equal(f.controller.scheduleTimer, null);
  f.controller.stopAutoChecks();
});

test('disabled source and portable runs do not check or schedule', async () => {
  const f = fixture({ disabledReason: '源码运行不使用桌面安装更新',
    setTimer: () => { throw new Error('Unexpected timer'); } });
  await f.controller.startAutoChecks();
  assert.equal(f.checks(), 0);
  await assert.rejects(f.controller.setSchedule({ enabled: true, time: '08:00' }), /源码运行/);
});

test('check errors are short local messages without HTTP headers, cookies or signed URLs', async () => {
  const f = fixture();
  const cases = [
    [Object.assign(new Error('Cannot find channel: HttpError: 404\nHeaders: Set-Cookie: private-fixture-value\nhttps://example.invalid/?token=secret'),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), '暂未找到当前发行包的更新信息'],
    [Object.assign(new Error('HttpError: 429\nHeaders: private-fixture-value'),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), '更新服务暂时受限，请稍后重试'],
    [Object.assign(new Error('private-fixture-value'), { code: 'ECONNRESET' }), '无法连接更新服务器，请稍后重试'],
    [new Error('unrecognized error: private-fixture-value'), '检查更新失败，请稍后重试'],
  ];
  for (const [error, expected] of cases) {
    f.updater.checkForUpdates = async () => { throw error; };
    const state = await f.controller.check();
    assert.equal(state.phase, 'error');
    assert.equal(state.error, expected);
    assert.doesNotMatch(JSON.stringify(state), /private-fixture-value|Headers:|Set-Cookie|token=secret/);
  }
});

test('preparation failure resumes service and permits a second installation attempt', async () => {
  let failing = true;
  let resumes = 0;
  const f = fixture({ prepare: async () => { if (failing) throw new Error('task still stopping'); }, resume: async () => { resumes++; } });
  await f.controller.check(); await f.controller.download();
  assert.equal((await f.controller.install()).phase, 'downloaded');
  assert.equal(resumes, 1); assert.equal(f.installs(), 0);
  failing = false;
  assert.equal((await f.controller.install()).phase, 'installing');
});

test('installer launch waits for a confirmed process and recovers from asynchronous failure before quit', async () => {
  let quits = 0;
  let child;
  const native = new EventEmitter();
  native.app = { quit: () => { quits++; } };
  native.quitAndInstall = () => {
    native.quitAndInstallCalled = true;
    native.spawnLog('fixture.exe').catch(error => native.emit('error', error));
    setImmediate(() => { void native.app.quit(); });
  };
  guardInstallerLaunch(native, () => { child = new EventEmitter(); child.unref = () => {}; return child; });
  let resumed = 0;
  const f = fixture({ updater: native, resume: async () => { resumed++; } });
  native.checkForUpdates = async () => { native.emit('update-available'); return { updateInfo: {
    version: '0.0.2', files: [{ url: installerName('0.0.2', 'offline'), sha512: digest }] } }; };
  native.downloadUpdate = async () => ['fixture.exe'];
  await f.controller.check(); await f.controller.download(); await f.controller.install();
  await tick();
  assert.equal(quits, 0, 'Never quit while process creation is pending.');
  child.emit('error', new Error('launch failed'));
  await tick();
  assert.equal(quits, 0); assert.equal(resumed, 1);
  assert.equal(native.quitAndInstallCalled, false);
  assert.equal(f.controller.snapshot().phase, 'downloaded');
  await f.controller.install(); await tick(); child.emit('spawn'); await tick();
  assert.equal(quits, 1);
});

test('only the current local main frame may invoke installation or receive state', async () => {
  const handlers = new Map(); const sent = [];
  let url = 'http://127.0.0.1:22267/';
  const frame = { get url() { return url; } };
  const contents = { mainFrame: frame, getURL: () => url, send: (...args) => sent.push(args) };
  const f = fixture();
  attachDesktopUpdater({ handle: (name, handler) => handlers.set(name, handler) }, {
    controller: f.controller, getWindow: () => ({ isDestroyed: () => false, webContents: contents }), pageUrl: () => 'http://127.0.0.1:22267/' });
  const get = handlers.get('yab-update:get');
  assert.equal(get({ sender: contents, senderFrame: frame }).currentVersion, '0.0.1');
  assert.throws(() => get({ sender: contents, senderFrame: {} }), /无效/);
  assert.throws(() => get({ sender: {}, senderFrame: frame }), /无效/);
  url = 'https://example.invalid/';
  assert.throws(() => get({ sender: contents, senderFrame: frame }), /无效/);
  await f.controller.check(); assert.equal(sent.length, 0);
});

test('startup confirmation records status without creating a configuration backup', async () => {
  const scratch = await newTestDirectory('update-journal-');
  const journal = path.join(scratch, 'journal.json');
  await writeRecord(journal, { status: 'pending', currentVersion: '0.0.1', targetVersion: '0.0.2' });
  const f = fixture({ version: '0.0.2', journal });
  await f.controller.confirmStartup('0.0.1');
  assert.equal(JSON.parse(await fs.readFile(journal)).status, 'failed');
  await writeRecord(journal, { status: 'pending', currentVersion: '0.0.1', targetVersion: '0.0.2' });
  await f.controller.confirmStartup('0.0.2');
  assert.equal(JSON.parse(await fs.readFile(journal)).status, 'complete');
  await assert.rejects(fs.access(path.join(scratch, 'backups')));
});

test('manifests contain exact variant filenames, content digests and immutable release URLs', async () => {
  const scratch = await newTestDirectory('update-manifest-');
  for (const variant of VARIANTS) {
    const config = updateConfig(variant);
    const name = installerName('0.0.2', variant);
    await fs.writeFile(path.join(scratch, name), Buffer.alloc(128, 6));
    const file = await createUpdateManifest(scratch, config, '0.0.2', '<plain notes>');
    const info = JSON.parse(await fs.readFile(file));
    assert.equal(path.basename(file), config.channel + '.yml');
    assert.equal(info.files[0].url, `${RELEASE_URL}/download/v0.0.2/${name}`);
    assert.equal(info.files[0].size, 128); assert.equal(Buffer.from(info.sha512, 'base64').length, 64);
  }
  assert.throws(() => updateConfig('offline', 'http://example.invalid'), /安全地址/);
  assert.throws(() => updateConfig('offline', 'https://user:secret@example.invalid'), /安全地址/);
});

test('installation markers require a nonempty absolute location matching the running executable', async () => {
  const scratch = await newTestDirectory('update-marker-');
  const executable = path.join(scratch, 'YAB.exe');
  const marker = path.join(scratch, 'yab-install-location');
  assert.equal(installedAt(executable, scratch), false);
  for (const value of ['', '.', path.join(scratch, 'different')]) {
    await fs.writeFile(marker, value, 'utf16le');
    assert.equal(installedAt(executable, scratch), false);
  }
  await fs.writeFile(marker, '\uFEFF' + scratch, 'utf16le');
  assert.equal(installedAt(executable, scratch), true);
});

test('real updater validates HTTP downloads, retry, variant feeds and the sandboxed UI', { timeout: 65000 }, async () => {
  const scratch = await newTestDirectory('desktop-update-ui-');
  const frontend = await prepareBuildInput('frontend');
  await fs.writeFile(path.join(scratch, 'package.json'), JSON.stringify({ name: 'yab-updater-fixture', version: '0.0.1',
    main: path.resolve(__dirname, 'updater-render.cjs') }));
  const env = { ...process.env, YAB_UPDATE_TEST_DATA: scratch, YAB_UPDATE_TEST_FRONTEND: frontend };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn(require('electron'), [scratch], { env, windowsHide: true });
    let logs = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data.toString(); });
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('Update UI timed out: ' + logs)); }, 60000);
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('exit', code => { clearTimeout(watchdog); resolve({ code, logs }); });
  });
  assert.equal(result.code, 0, result.logs);
  assert.match(result.logs, /DESKTOP_UPDATE_OK/);
});

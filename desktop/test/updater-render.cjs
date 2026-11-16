'use strict';

// Real updater + HTTP transport + sandboxed webpage. Installer execution is recorded.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, ipcMain } = require('electron');
const { NsisUpdater } = require('electron-updater');
const { DesktopUpdater, attachDesktopUpdater, guardInstallerLaunch } = require('../updater.cjs');
const { updateConfig, createUpdateManifest, installerName, VARIANTS } = require('../update-config.cjs');

const scratch = process.env.YAB_UPDATE_TEST_DATA;
const frontend = process.env.YAB_UPDATE_TEST_FRONTEND;
app.setPath('userData', path.join(scratch, 'browser'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;
let server;
let corrupt = true;
let manifestMissing = true;
const requests = [];
const diagnostics = [];
const payload = randomBytes(256 * 1024);
const installed = [];
let launchFailure = true;

async function main() {
  await app.whenReady();
  server = http.createServer(async (request, response) => {
    try {
      const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      requests.push(route);
      if (manifestMissing && route.endsWith('.yml')) {
        response.writeHead(404, { 'Set-Cookie': 'fixture-update-cookie=private-fixture-value' }).end('No update manifest');
        return;
      }
      if (route.endsWith('.blockmap')) { response.writeHead(404).end(); return; }
      if (route.endsWith('.exe')) {
        const bytes = corrupt ? Buffer.alloc(payload.length, 0) : payload;
        response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' });
        for (let offset = 0; offset < bytes.length; offset += 16384) {
          if (response.destroyed) break;
          response.write(bytes.subarray(offset, offset + 16384)); await sleep(90);
        }
        response.end(); return;
      }
      const base = route.endsWith('.yml') ? scratch : frontend;
      const filename = path.resolve(base, '.' + (route === '/' ? '/index.html' : route));
      if (!filename.startsWith(base + path.sep)) throw new Error('Invalid path');
      const bytes = await fs.readFile(filename);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(filename)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': mime }); response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const make = async variant => {
    const config = updateConfig(variant, url);
    await fs.writeFile(path.join(scratch, installerName('0.0.2', variant)), payload);
    await createUpdateManifest(scratch, config, '0.0.2', '<img src=x onerror=alert(1)> plain release notes');
    const settings = path.join(scratch, `${variant}-config.yml`);
    await fs.writeFile(settings, JSON.stringify({ ...config, updaterCacheDirName: `update-${variant}` }));
    const native = new NsisUpdater({ provider: 'generic', url: config.url, channel: config.channel });
    native.installDirectory = path.join(scratch, 'installed application');
    native.app.quit = () => { installed.push('quit'); };
    guardInstallerLaunch(native, (command, args, options) => {
      const child = new EventEmitter(); child.unref = () => {};
      installed.push({ command, args, options });
      setImmediate(() => launchFailure
        ? child.emit('error', Object.assign(new Error('fixture missing installer'), { code: 'ENOENT' }))
        : child.emit('spawn'));
      return child;
    });
    Object.defineProperty(native.app, 'baseCachePath', { value: path.join(scratch, 'cache') });
    native.updateConfigPath = settings;
    // updateConfigPath resets the provider; restore the same explicit feed.
    native.setFeedURL({ provider: 'generic', url: config.url, channel: config.channel, useMultipleRangeRequest: false });
    native.forceDevUpdateConfig = true;
    native.logger = { info: value => diagnostics.push(value), warn: value => diagnostics.push(value), error: value => diagnostics.push(value) };
    return { config, native };
  };
  const { config, native } = await make('offline');
  let prepared = 0;
  let resumed = 0;
  let now = new Date(2026, 10, 15, 7, 0).getTime();
  const settingsFile = path.join(scratch, 'config', 'desktop-update.json');
  const controller = new DesktopUpdater({ updater: native, version: '0.0.1', config,
    clock: () => now, settingsFile,
    prepare: async () => { prepared++; }, resume: async () => { resumed++; } });
  const check = controller.check.bind(controller);
  let automaticChecks = 0;
  controller.check = options => {
    if (options?.automatic) automaticChecks++;
    return check(options);
  };
  window = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { preload: path.resolve(__dirname, '../preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  attachDesktopUpdater(ipcMain, { controller, getWindow: () => window, pageUrl: () => url });
  const run = code => window.webContents.executeJavaScript(code);
  const until = async code => {
    for (let count = 0; count < 500; count++) { if (await run(code)) return; await sleep(30); }
    throw new Error('UI timed out: ' + code + '\n' + await run('document.body.innerText') + '\n' + diagnostics.join('\n'));
  };
  const click = text => run(`Array.from(document.querySelectorAll('.desktop-update button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`);
  const manifestRequests = () => requests.filter(item => item.endsWith('.yml')).length;
  const enterUpdate = async () => {
    const previous = automaticChecks;
    await run('location.hash = "#/default_config/home"');
    await until('!document.querySelector(".desktop-update")');
    await run("document.querySelector('.global-nav a[href=\"#/update\"]').click()");
    await until('!!document.querySelector(".desktop-update .status")');
    for (let count = 0; automaticChecks === previous && count < 100; count++) await sleep(10);
    assert.equal(automaticChecks, previous + 1, 'Entering the update page requests an automatic check');
  };
  const assertInlineStatus = async () => {
    const layout = await run(`(() => {
      const status = document.querySelector('.desktop-update .status');
      const button = status.previousElementSibling;
      const statusRect = status.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const card = document.querySelector('.desktop-update');
      return { label: button.textContent.trim(), gap: statusRect.left - buttonRect.right,
        centerDifference: Math.abs((statusRect.top + statusRect.bottom - buttonRect.top - buttonRect.bottom) / 2),
        fits: card.scrollWidth <= card.clientWidth };
    })()`);
    assert.equal(layout.label, '检查更新');
    assert.ok(layout.gap >= 5, JSON.stringify(layout));
    assert.ok(layout.centerDifference < 2, JSON.stringify(layout));
    assert.equal(layout.fits, true);
  };
  await window.loadURL(url + '#/update');
  await until('document.querySelector(".desktop-update .status")?.textContent === "暂未找到当前发行包的更新信息"');
  assert.equal(manifestRequests(), 1, 'Opening the page checks without clicking the button');
  assert.equal(automaticChecks, 1);
  assert.doesNotMatch(await run('document.querySelector(".desktop-update").textContent'), /private-fixture-value|Set-Cookie|Headers:|Cannot find channel|authentication token/i);
  for (const width of [1280, 960]) {
    window.setSize(width, 800);
    await sleep(40);
    await assertInlineStatus();
  }
  assert.equal(await run('document.querySelector("#update-schedule-enabled").checked'), false);
  assert.equal(await run('document.querySelector("#update-schedule-time") === null'), true);
  await run('document.querySelector("#update-schedule-enabled").click()');
  await until('!document.querySelector("#update-schedule-enabled").disabled && document.querySelector("#update-schedule-time")?.value === "08:00"');
  assert.deepEqual(controller.snapshot().schedule, { enabled: true, time: '08:00' });
  await run(`(() => {
    const input = document.querySelector('#update-schedule-time');
    input.value = '09:45'; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until('!document.querySelector("#update-schedule-enabled").disabled && document.querySelector("#update-schedule-time")?.value === "09:45"');
  assert.deepEqual(controller.snapshot().schedule, { enabled: true, time: '09:45' });
  const setSchedule = controller.setSchedule.bind(controller);
  controller.setSchedule = async () => { throw new Error('private-fixture-value'); };
  await run('document.querySelector("#update-schedule-enabled").click()');
  await until('document.querySelector(".desktop-update .schedule-error")?.textContent === "更新检查设置保存失败，请重试"');
  assert.equal(await run('document.querySelector("#update-schedule-enabled").checked'), true);
  assert.equal(await run('document.querySelector("#update-schedule-time")?.value'), '09:45');
  controller.setSchedule = setSchedule;
  await run('document.querySelector("#update-schedule-enabled").click()');
  await until('!document.querySelector("#update-schedule-enabled").disabled && !document.querySelector("#update-schedule-time")');
  assert.deepEqual(controller.snapshot().schedule, { enabled: false, time: '09:45' });
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')), { enabled: false, time: '09:45' });
  manifestMissing = false;
  await click('检查更新');
  await until('document.querySelector(".desktop-update .status")?.textContent === "有新版本可用"');
  assert.equal(manifestRequests(), 2, 'Manual retry bypasses the automatic cooldown');
  for (let index = 0; index < 3; index++) await enterUpdate();
  assert.equal(manifestRequests(), 2, 'Rapid page switches reuse the previous check');
  now += 30001;
  await enterUpdate();
  if (controller.pending) await controller.pending;
  await until('document.querySelector(".desktop-update .status")?.textContent === "有新版本可用"');
  assert.equal(manifestRequests(), 3, 'Entering again after the cooldown refreshes update information');
  assert.equal(prepared, 0);
  assert.equal(await run('document.querySelector(".desktop-update .notes img") === null'), true);
  await click('下载更新');
  await until('!!document.querySelector(".desktop-update progress")');
  await until('document.querySelector(".desktop-update .status.error")?.textContent === "更新包校验失败，请重新下载"');
  await assertInlineStatus();
  assert.equal(controller.snapshot().phase, 'error'); assert.equal(prepared, 0);
  corrupt = false;
  await click('下载更新');
  await until('document.querySelector(".desktop-update .status")?.textContent === "更新已下载"');
  const files = await native.downloadUpdate();
  assert.deepEqual(await fs.readFile(files[0]), payload);
  assert.equal(installed.length, 0);
  assert.ok(requests.some(item => item.endsWith('.blockmap')), 'Exercise failed differential download with full-download fallback.');
  assert.ok(diagnostics.some(item => item.includes('fallback to full download')));
  for (const name of ['versions', 'backups', 'updates']) {
    await assert.rejects(fs.access(path.join(scratch, 'browser', name)));
  }
  await window.webContents.reload();
  await until('document.querySelector(".desktop-update .status")?.textContent === "更新已下载"');
  assert.equal(manifestRequests(), 3, 'Reloading the page preserves a downloaded update');
  window.setSize(960, 640);
  assert.equal(await run('document.querySelector(".desktop-update").scrollWidth <= document.querySelector(".desktop-update").clientWidth'), true);
  await click('重启并更新');
  await until('document.querySelector(".desktop-update .status.error")?.textContent === "安装器未能启动，请重试"');
  await assertInlineStatus();
  assert.equal(prepared, 1); assert.equal(resumed, 1);
  assert.equal(installed.includes('quit'), false);
  launchFailure = false;
  await click('重启并更新');
  await until('document.querySelector(".desktop-update .status")?.textContent === "正在启动安装器…"');
  await sleep(40);
  assert.equal(prepared, 2); assert.equal(resumed, 1);
  assert.deepEqual(installed[1].args, ['--updated', '/S', '--force-run', `/D=${native.installDirectory}`]);
  assert.equal(installed[1].options.windowsHide, true);
  assert.equal(installed[2], 'quit');
  for (const variant of VARIANTS.filter(item => item !== 'offline')) {
    const f = await make(variant);
    const other = new DesktopUpdater({ updater: f.native, version: '0.0.1', config: f.config, prepare: async () => {} });
    assert.equal((await other.check()).phase, 'available');
    assert.equal((await other.download()).phase, 'downloaded');
    assert.ok(requests.includes(`/${f.config.channel}.yml`));
  }
  await fs.writeFile(path.join(scratch, 'result.json'), JSON.stringify({ checksumRejected: true,
    fullDownloadFallback: true, variants: VARIANTS, installRecorded: installed, diagnostics }, null, 2));
  console.log('DESKTOP_UPDATE_OK');
}

main().then(() => { window?.destroy(); server?.close(); app.exit(0); }).catch(error => {
  console.error(error); window?.destroy(); server?.close(); app.exit(1);
});

'use strict';
const { app, BrowserWindow, dialog, nativeTheme, session } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('timers/promises');
const { showMessage } = require('../message-window.cjs');
app.setPath('userData', process.env.YAB_DIALOG_TEST_DATA);
app.disableHardwareAcceleration();
// The hidden preview should start its renderer at the same priority as a
// visible message. Timer throttling alone does not control process priority.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
const timeline = [];
app.on('web-contents-created', (_event, contents) => {
  // These previews are never shown. Keep their renderers active just as the
  // other hidden UI regressions do, regardless of desktop visibility.
  contents.setBackgroundThrottling(false);
  const record = (event, data) => timeline.push({ at: Date.now(), id: contents.id, event, ...data });
  for (const event of ['did-start-loading', 'dom-ready', 'did-finish-load', 'did-stop-loading']) {
    contents.on(event, () => record(event));
  }
  contents.on('console-message', event => record('console', { level: event.level, message: event.message }));
  contents.on('preload-error', (_event, preload, error) => record('preload-error', { preload, message: error.message }));
  contents.on('did-fail-load', (_event, code, message, url) => record('did-fail-load', { code, message, url }));
  contents.on('render-process-gone', (_event, details) => record('render-process-gone', details));
});
async function ready(window) {
  const contents = window.webContents;
  const deadline = Date.now() + 10000;
  // Wait for the local page before polling its buttons. Both stages share
  // the original deadline, including a renderer that never answers a query.
  if (contents.isLoading()) {
    try {
      await once(contents, 'did-stop-loading', { signal: AbortSignal.timeout(10000) });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }
  const waitingFor = contents.isLoading() ? 'navigation' : 'message buttons';
  let watchdog;
  const initialized = waitingFor === 'message buttons' && await Promise.race([
    (async () => {
      while (Date.now() < deadline) {
        if (window.isDestroyed()) throw new Error('Message preview closed before becoming ready');
        if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("document.querySelectorAll('button').length > 0")) return true;
        await delay(30);
      }
      return false;
    })(),
    new Promise(resolve => { watchdog = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); }),
  ]).finally(() => clearTimeout(watchdog));
  if (initialized) return;
  const state = { waitingFor, url: contents.getURL(), loading: contents.isLoading(), mainFrameLoading: contents.isLoadingMainFrame() };
  // A renderer stuck during navigation may not answer even a diagnostic query.
  // Preserve the main-process evidence before attempting a bounded page read.
  const report = path.join(app.getPath('userData'), 'readiness-failure.json');
  fs.writeFileSync(report, JSON.stringify({ state, timeline }, null, 2));
  state.page = await Promise.race([
    contents.executeJavaScript("({ready: document.readyState, buttons: document.querySelectorAll('button').length, bridge: Boolean(window.yabMessage), body: document.body?.innerText})")
      .catch(error => ({ error: error.message })),
    delay(300).then(() => ({ error: 'Renderer did not answer the diagnostic query' })),
  ]);
  fs.writeFileSync(report, JSON.stringify({ state, timeline }, null, 2));
  throw new Error('Message preview timed out waiting for ' + waitingFor + ': ' + JSON.stringify({ state, timeline, report }));
}

async function captureMessage(window) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      return await window.webContents.capturePage(undefined, { stayHidden: true });
    } catch (error) {
      // Chromium may not have submitted a compositor frame when the DOM is ready.
      if (error.message !== 'UnknownVizError') throw error;
      if (Date.now() >= deadline) {
        throw new Error('Message preview did not produce a compositor frame within 2 seconds', { cause: error });
      }
      await delay(50);
    }
  }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onErrorOccurred(details => {
    timeline.push({ at: Date.now(), id: details.webContentsId, event: 'resource-error', url: details.url, error: details.error });
  });
  const systemDark = nativeTheme.shouldUseDarkColors;
  for (const theme of [process.env.YAB_DIALOG_TEST_THEME]) {
    nativeTheme.themeSource = theme;
    const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const detail = '<script>literal detail</script>\n' + '很长的错误日志 '.repeat(120);
    const result = showMessage(owner, { title: 'YAB message preview', message: '运行环境准备失败', detail,
      buttons: ['重试', '退出'], cancelId: 1 }, { show: false });
    const window = BrowserWindow.getAllWindows().find(value => value !== owner);
    await ready(window);
    const state = await window.webContents.executeJavaScript(`({
      background: getComputedStyle(document.documentElement).backgroundColor,
      detail: document.getElementById('detail').textContent,
      focus: document.activeElement.textContent,
      overflow: document.body.scrollWidth > innerWidth,
      role: document.querySelector('main').getAttribute('role'),
    })`);
    assert.equal(state.background, theme === 'dark' ? 'rgb(32, 32, 32)' : 'rgb(255, 255, 255)');
    assert.equal(state.detail, detail);
    assert.equal(state.focus, '重试');
    assert.equal(state.overflow, false);
    assert.equal(state.role, 'alertdialog');
    const image = await captureMessage(window);
    fs.writeFileSync(path.join(app.getPath('userData'), `message-${theme}.png`), image.toPNG());
    const bitmap = image.toBitmap();
    const offset = (10 * image.getSize().width + 10) * 4;
    assert.equal(bitmap[offset], theme === 'dark' ? 32 : 255);
    const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
      preload: path.resolve(__dirname, '../message-preload.cjs'),
      additionalArguments: ['--yab-message-channel=yab-message:1'] } });
    await other.loadURL('data:text/html,<html><body>untrusted window</body></html>');
    assert.equal(await other.webContents.executeJavaScript("window.yabMessage.get().then(() => false, error => error.message.includes('无效的消息请求'))"), true);
    other.destroy();
    // Return from evaluation before the action closes its renderer.
    await window.webContents.executeJavaScript("setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 0)");
    assert.equal((await result).response, 1);
    const next = showMessage(owner, { message: '启动失败', buttons: ['确定'] }, { show: false });
    const single = BrowserWindow.getAllWindows().find(value => value !== owner);
    await ready(single);
    single.webContents.debugger.attach('1.3');
    await single.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    assert.equal(await single.webContents.executeJavaScript("matchMedia('(forced-colors: active)').matches"), true);
    const contrast = await single.webContents.executeJavaScript("({bg:getComputedStyle(document.documentElement).backgroundColor,fg:getComputedStyle(document.documentElement).color})");
    assert.notEqual(contrast.bg, contrast.fg);
    single.webContents.debugger.detach();
    await single.webContents.executeJavaScript("setTimeout(() => document.querySelector('button').click(), 0)");
    assert.equal((await next).response, 0);
    const closed = showMessage(owner, { message: '已继续使用上一版本', buttons: ['确定', '取消'] }, { show: false });
    const closing = BrowserWindow.getAllWindows().find(value => value !== owner);
    await ready(closing);
    closing.close();
    assert.equal((await closed).response, 1);
    owner.destroy();
  }
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  console.log('MESSAGE_SHELL_READY');
  const file = await dialog.showOpenDialog(window, { title: 'YAB-PREVIEW:file:3', properties: ['openFile'],
    filters: [{ name: 'uv', extensions: ['exe'] }] });
  fs.writeFileSync(path.join(app.getPath('userData'), 'result.json'), JSON.stringify({ file, systemDark }));
  console.log('MESSAGE_UI_OK');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const http = require('http');
const { app, BrowserWindow, ipcMain } = require('electron');
const { WindowMemoryMode, attachWindowSettings, readWindowMode } = require('../window-mode.cjs');
const { showMessage } = require('../message-window.cjs');

app.setPath('userData', process.env.YAB_LIGHT_MODE_TEST_DATA);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForPage(window, condition) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(condition)) return;
    await sleep(20);
  }
  throw new Error('Page condition did not complete: ' + condition);
}
let ready = false;
let quitting = false;
let notifications = 0;
let windowsCreated = 0;
let requests = 0;
let ticks = 0;
const mode = new WindowMemoryMode({ canRelease: () => ready, isQuitting: () => quitting,
  onHidden: () => { notifications++; } });
mode.closeAction = '仅关闭窗口';
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  const interval = setInterval(() => { ticks++; }, 20);
  let serveFrontend = false;
  const server = http.createServer(async (request, response) => {
    requests++;
    if (serveFrontend) {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const filename = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
      const type = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
      response.setHeader('Content-Type', type);
      try { response.end(await fs.readFile(path.join(process.env.YAB_LIGHT_MODE_FRONTEND, filename))); }
      catch { response.writeHead(404); response.end(); }
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>轻量模式回归</title><input id="draft"><script>window.ready = true;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const settingsFile = path.join(process.env.YAB_LIGHT_MODE_TEST_DATA, 'desktop-settings.json');
  attachWindowSettings(ipcMain, { mode, filename: settingsFile,
    getWindow: () => mode.window, pageUrl: () => url });
  const create = async state => {
    windowsCreated++;
    const window = new BrowserWindow({ ...(state?.bounds || { width: 960, height: 640 }), show: false, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
        preload: path.resolve(__dirname, '../preload.js') } });
    // Keep the rendering test invisible on the user's desktop.
    window.show = () => {};
    window.focus = () => {};
    mode.attach(window);
    await window.loadURL(mode.pageUrl(url));
    return window;
  };
  try {
    let window = await mode.show(create);
    const contents = window.webContents;
    window.close();
    assert.equal(window.isDestroyed(), false, 'normal mode must retain its renderer');
    assert.equal(contents.isDestroyed(), false);
    mode.closeAction = '开启轻量模式';
    window.close();
    assert.equal(window.isDestroyed(), false, 'startup must keep its window');
    ready = true;
    await window.webContents.executeJavaScript('location.hash = "#/default_config/schedule"; document.querySelector("input").value = "未保存"');
    window.setBounds({ x: 80, y: 90, width: 1024, height: 700 });
    const expectedBounds = window.getBounds();
    const beforeTicks = ticks;
    window.close();
    assert.equal(window.isDestroyed(), true);
    for (let count = 0; count < 100 && !contents.isDestroyed(); count++) await sleep(20);
    assert.equal(contents.isDestroyed(), true, 'released window must destroy web contents');
    assert.equal(mode.window, null);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    await sleep(100);
    assert.ok(ticks > beforeTicks, 'the background service must continue with no windows');
    assert.equal((await fetch(url)).status, 200);
    const resumed = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const started = performance.now();
      const count = windowsCreated;
      const restored = await Promise.all([mode.show(create), mode.show(create), mode.show(create)]);
      assert.ok(restored.every(item => item === restored[0]));
      window = restored[0];
      assert.equal(windowsCreated, count + 1, 'rapid clicks must not create duplicate windows');
      // Windows rounds native frame sizes to physical pixels under display scaling.
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(window.getBounds()[key] - expectedBounds[key]) <= 3,
          `restored ${key}: ${window.getBounds()[key]} / ${expectedBounds[key]}`);
      }
      assert.ok(window.webContents.getURL().endsWith('#/default_config/schedule'));
      assert.equal(await window.webContents.executeJavaScript('window.ready'), true);
      assert.equal(await window.webContents.executeJavaScript('document.querySelector("input").value'), '');
      resumed.push(Math.round(performance.now() - started));
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      window.close();
      assert.equal(window.isDestroyed(), true);
    }
    window = await mode.show(create);
    serveFrontend = true;
    window.webContents.debugger.attach('1.3');
    const motionPreference = value => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value }],
    });
    await motionPreference('no-preference');
    await window.loadURL(url + '?settings=1#/default_config/settings');
    const settingsReady = async () => {
      for (let count = 0; count < 100; count++) {
        if (await window.webContents.executeJavaScript('Boolean(document.querySelector("#desktop-close-action") && !document.querySelector("#desktop-close-action").disabled)')) return;
        await sleep(20);
      }
      throw new Error('Desktop settings did not become ready');
    };
    await settingsReady();
    assert.deepEqual(await window.webContents.executeJavaScript('Array.from(document.querySelector("#desktop-close-action").options, option => option.textContent)'),
      ['仅关闭窗口', '开启轻量模式', '询问']);
    for (const action of ['仅关闭窗口', '开启轻量模式', '询问']) {
      await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('#desktop-close-action'); select.value = ${JSON.stringify(action)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await settingsReady();
      assert.equal(mode.closeAction, action);
      assert.equal(readWindowMode(settingsFile), action);
    }
    // Check the real notification: close button at the right and remaining time above.
    await sleep(220);
    const notification = await window.webContents.executeJavaScript(`(() => {
      const toast = document.querySelector('.toast');
      const button = toast.querySelector('.tclose');
      const timer = toast.querySelector('.toast-timer');
      const rect = toast.getBoundingClientRect();
      const close = button.getBoundingClientRect();
      const bar = timer.getBoundingClientRect();
      const animation = timer.getAnimations()[0];
      const duration = animation.effect.getTiming().duration;
      animation.pause();
      animation.currentTime = duration / 2;
      const half = timer.getBoundingClientRect().width;
      return { rightGap: rect.right - close.right, topGap: bar.top - rect.top,
        halfRatio: half / (rect.width - 2), duration, label: button.getAttribute('aria-label') };
    })()`);
    assert.ok(notification.rightGap >= 10 && notification.rightGap < 24);
    assert.ok(notification.topGap >= 0 && notification.topGap <= 2);
    assert.ok(Math.abs(notification.halfRatio - 0.5) < 0.02);
    assert.equal(notification.duration, 3500);
    assert.equal(notification.label, '关闭');
    await window.webContents.executeJavaScript('document.querySelectorAll(".tclose").forEach(button => button.click())');
    await waitForPage(window, 'document.querySelectorAll(".toast").length === 0');
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".toast").length'), 0,
      await window.webContents.executeJavaScript(`JSON.stringify({ hidden: document.hidden,
        toasts: Array.from(document.querySelectorAll('.toast'), node => ({
          opacity: getComputedStyle(node).opacity, inert: node.inert,
          animations: node.getAnimations().map(animation => ({ state: animation.playState,
            time: animation.currentTime, timing: animation.effect.getTiming() })),
        })) })`));

    const notify = async () => {
      const previous = await window.webContents.executeJavaScript('document.querySelectorAll(".toast").length');
      await window.webContents.executeJavaScript('document.querySelector("#desktop-close-action").dispatchEvent(new Event("change", { bubbles: true }))');
      await settingsReady();
      for (let count = 0; count < 100; count++) {
        if (await window.webContents.executeJavaScript('document.querySelectorAll(".toast").length') === previous + 1) return;
        await sleep(20);
      }
      throw new Error('Notification did not appear');
    };
    await notify();
    await notify();
    await notify();
    await sleep(220);
    const pointer = async point => window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', ...point,
    });
    const hovered = await window.webContents.executeJavaScript(`(() => {
      [window.hoveredToast, window.focusedToast, window.automaticToast] = document.querySelectorAll('.toast');
      const rect = window.hoveredToast.getBoundingClientRect();
      window.focusedToast.querySelector('button').focus();
      return { x: rect.left + 30, y: rect.top + rect.height / 2 };
    })()`);
    await pointer(hovered);
    assert.equal(await window.webContents.executeJavaScript('window.hoveredToast.matches(":hover")'), true);
    await sleep(3800);
    assert.deepEqual(await window.webContents.executeJavaScript(`(() => ({
      hovered: window.hoveredToast.isConnected,
      focused: window.focusedToast.isConnected,
      automatic: window.automaticToast.isConnected,
      remaining: window.hoveredToast.querySelector('.toast-timer').getBoundingClientRect().width,
    }))()`), { hovered: true, focused: true, automatic: false, remaining: 0 });
    const beforeExit = await window.webContents.executeJavaScript('window.hoveredToast.getBoundingClientRect().height');
    await pointer({ x: 5, y: 500 });
    const exit = await window.webContents.executeJavaScript(`(async () => {
      await new Promise(requestAnimationFrame);
      const animation = window.hoveredToast.getAnimations()[0];
      if (!animation) throw new Error('Notification exit animation did not start');
      animation.pause();
      animation.currentTime = animation.effect.getTiming().duration / 2;
      const result = { opacity: Number(getComputedStyle(window.hoveredToast).opacity),
        height: window.hoveredToast.getBoundingClientRect().height,
        nextTop: window.focusedToast.getBoundingClientRect().top };
      animation.play();
      return result;
    })()`);
    assert.ok(exit.opacity > 0 && exit.opacity < 1, JSON.stringify(exit));
    assert.ok(exit.height > 0 && exit.height < beforeExit, JSON.stringify(exit));
    assert.ok(exit.nextTop > 16 && exit.nextTop < 16 + beforeExit + 8, JSON.stringify(exit));
    await waitForPage(window, '!window.hoveredToast.isConnected');
    assert.equal(await window.webContents.executeJavaScript('window.hoveredToast.isConnected'), false);
    assert.equal(await window.webContents.executeJavaScript('window.focusedToast.isConnected'), true);
    await window.webContents.executeJavaScript('window.focusedToast.querySelector("button").blur()');
    await waitForPage(window, '!window.focusedToast.isConnected');
    assert.equal(await window.webContents.executeJavaScript('window.focusedToast.isConnected'), false);

    // An explicit close still works while hovered; reduced motion skips animation.
    await motionPreference('reduce');
    await notify();
    const manual = await window.webContents.executeJavaScript(`(() => {
      window.manualToast = document.querySelector('.toast');
      const rect = window.manualToast.getBoundingClientRect();
      return { x: rect.left + 30, y: rect.top + rect.height / 2, animations: window.manualToast.getAnimations().length };
    })()`);
    assert.equal(manual.animations, 0);
    await pointer({ x: manual.x, y: manual.y });
    assert.equal(await window.webContents.executeJavaScript('window.manualToast.matches(":hover")'), true);
    await window.webContents.executeJavaScript('window.manualToast.querySelector("button").click()');
    await sleep(40);
    assert.equal(await window.webContents.executeJavaScript('window.manualToast.isConnected'), false);
    await pointer({ x: 5, y: 500 });
    await motionPreference('no-preference');
    for (const width of [1280, 1184, 960]) {
      window.setSize(width, 800);
      await sleep(30);
      assert.equal(await window.webContents.executeJavaScript(`(() => { const card = document.querySelector('.desktop-settings'); const select = card.querySelector('select'); const a = card.getBoundingClientRect(); const b = select.getBoundingClientRect(); const label = card.querySelector("label").getBoundingClientRect(); return b.width >= 130 && b.width <= 202 && b.left >= label.right + 12 && Math.abs((b.top + b.bottom) / 2 - (label.top + label.bottom) / 2) < 8 && b.right <= a.right && card.scrollWidth <= card.clientWidth && getComputedStyle(card.querySelector("h2")).color === getComputedStyle(document.querySelector(".sec h2")).color; })()`), true);
      assert.equal(await window.webContents.executeJavaScript(`(() => {
      const web = document.querySelector('.web-settings');
      const desktop = document.querySelector('.desktop-settings');
      const script = document.querySelector('.sec');
      const equalTitles = [web, desktop].every(card => {
        const title = getComputedStyle(card.querySelector('h2'));
        const other = getComputedStyle(script.querySelector('h2'));
        return title.color === other.color && title.fontSize === other.fontSize && title.fontWeight === other.fontWeight;
      });
      const fields = ['web-listen-host', 'web-listen-port', 'desktop-close-action'].every(id => {
        const input = document.getElementById(id).getBoundingClientRect();
        const label = document.querySelector('label[for="' + id + '"]').getBoundingClientRect();
        return input.left >= label.right + 12 && Math.abs(input.top - label.top) < 8;
      });
      const input = document.querySelector('#web-listen-port').getBoundingClientRect();
      const save = web.querySelector('button').getBoundingClientRect();
      return equalTitles && fields && Math.abs(input.top - save.top) < 4 && save.right <= web.getBoundingClientRect().right - 12;
    })()`), true);
    }
    assert.equal(await window.webContents.executeJavaScript('window.yabDesktop.getCloseAction()'), '询问');
    assert.equal(await window.webContents.executeJavaScript('window.yabDesktop.setCloseAction("询问")'), '询问');
    assert.equal(readWindowMode(settingsFile), '询问');
    assert.equal(await window.webContents.executeJavaScript('window.yabDesktop.setCloseAction("invalid").then(() => false, () => true)'), true);
    const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
      preload: path.resolve(__dirname, '../preload.js') } });
    await other.loadURL(url);
    assert.equal(await other.webContents.executeJavaScript('window.yabDesktop.setCloseAction("开启轻量模式").then(() => false, () => true)'), true);
    other.destroy();
    await window.webContents.executeJavaScript('location.hash = "#/update"');
    for (let count = 0; count < 100; count++) {
      if (await window.webContents.executeJavaScript('Boolean(document.querySelector("#upd-sha"))')) break;
      await sleep(20);
    }
    for (const width of [1280, 960]) {
      window.setSize(width, 800);
      await sleep(30);
      assert.equal(await window.webContents.executeJavaScript(`(() => {
        const page = document.querySelector('.page');
        const titles = Array.from(document.querySelectorAll('.settings-card h2'));
        const fields = Array.from(document.querySelectorAll('.settings-card .field'));
        return page.scrollWidth <= page.clientWidth && titles.length === 2 && fields.length === 3
          && titles.every(title => getComputedStyle(title).color === 'rgb(122, 162, 247)' && getComputedStyle(title).fontSize === '15px')
          && fields.every(field => {
            const label = field.querySelector('label').getBoundingClientRect();
            const control = field.querySelector('.input').getBoundingClientRect();
            return control.left >= label.right + 12 && Math.abs(control.top - label.top) < 8;
          });
      })()`), true);
    }
    await window.webContents.executeJavaScript('location.hash = "#/default_config/settings"');
    await settingsReady();
    mode.ask = owner => showMessage(owner, { message: '关闭窗口后开启轻量模式？',
      detail: '轻量模式会释放界面，后台任务继续运行。',
      buttons: ['开启轻量模式', '仅关闭窗口', '取消'], defaultId: 0, cancelId: 2,
      checkboxLabel: '下次不再提示', checkboxChecked: true }, { show: false });
    const waitForDialog = async owner => {
      for (let count = 0; count < 100; count++) {
        const dialog = BrowserWindow.getAllWindows().find(item => item !== owner);
        if (dialog && !dialog.webContents.isLoading() && await dialog.webContents.executeJavaScript('document.querySelectorAll("button").length === 3')) return dialog;
        await sleep(20);
      }
      throw new Error('Close prompt did not load');
    };
    // Cancelling never saves a preference and leaves the main window intact.
    let closing = mode.requestClose(window);
    let dialog = await waitForDialog(window);
    assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#remember").checked'), true);
    assert.equal(await dialog.webContents.executeJavaScript('document.querySelector("#remember-row").hidden'), false);
    dialog.close();
    await closing;
    assert.equal(window.isDestroyed(), false);
    assert.equal(mode.closeAction, '询问');
    // Unchecking the default checkbox applies this choice only once.
    closing = mode.requestClose(window);
    dialog = await waitForDialog(window);
    await dialog.webContents.executeJavaScript('document.querySelector("#remember").checked = false; document.querySelectorAll("button")[1].click()');
    await closing;
    assert.equal(window.isDestroyed(), false);
    assert.equal(mode.closeAction, '询问');
    // Remembering the light-mode choice releases the renderer and persists it.
    mode.save = action => require('../window-mode.cjs').saveWindowMode(settingsFile, action);
    closing = mode.requestClose(window);
    dialog = await waitForDialog(window);
    await dialog.webContents.executeJavaScript('document.querySelectorAll("button")[0].click()');
    await closing;
    assert.equal(window.isDestroyed(), true);
    assert.equal(readWindowMode(settingsFile), '开启轻量模式');
    assert.equal(mode.closeAction, '开启轻量模式');
    mode.state.url = 'https://example.com/';
    assert.equal(mode.pageUrl(url), url, 'restoration cannot navigate to another origin');
    // A failed restore must clear the pending operation so retry is possible.
    await assert.rejects(mode.show(async () => { throw new Error('load failed'); }), /load failed/);
    assert.equal(mode.opening, null);
    window = await mode.show(create);
    quitting = true;
    const closed = new Promise(resolve => window.once('closed', resolve));
    window.close();
    await closed;
    assert.equal(window.isDestroyed(), true, 'quitting must not be intercepted');
    assert.ok(notifications >= 6);
    const report = { windowsCreated, requests, backendTicks: ticks, restoreMilliseconds: resumed };
    await fs.writeFile(path.join(process.env.YAB_LIGHT_MODE_TEST_DATA, 'result.json'), JSON.stringify(report, null, 2));
    console.log('LIGHT_MODE_OK ' + JSON.stringify(report));
  } finally {
    clearInterval(interval);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

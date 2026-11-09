'use strict';

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const assert = require('assert/strict');
const { setTimeout: delay } = require('timers/promises');
const { StartupProgress, attachStartupProgress, createStartupScreen } = require('../startup.cjs');

app.setPath('userData', process.env.YAB_STARTUP_UI_TEST_DATA);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
async function until(window, predicate) {
  for (let count = 0; count < 100; count++) {
    if (await window.webContents.executeJavaScript(predicate)) return;
    await delay(40);
  }
  throw new Error('启动界面等待超时：' + predicate);
}
app.whenReady().then(async () => {
  const progress = new StartupProgress();
  const window = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { preload: path.resolve(__dirname, '../preload.js'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  attachStartupProgress(window, progress, ipcMain);
  // Output emitted before the renderer subscribes must still be visible.
  progress.report('正在下载并安装锁定依赖…', 50);
  progress.append('开始准备运行环境\n');
  await window.loadFile(path.resolve(__dirname, '../startup.html'));
  await until(window, "document.getElementById('logs').textContent.includes('开始准备运行环境')");
  progress.append('正在下');
  progress.append('载依赖\n<img src=x onerror="window.injected=true">\n');
  progress.setEnvironment('C:\\Users\\测试用户\\AppData\\Roaming\\yab-desktop\\runtimes\\环境目录\\.venv');
  await until(window, "document.getElementById('logs').textContent.includes('正在下载依赖')");
  assert.equal(await window.webContents.executeJavaScript('Boolean(window.injected) || Boolean(document.querySelector("pre img"))'), false);
  const logLines = Array.from({ length: 250 }, (_, index) => `正在准备依赖 ${index}：下载、解压、校验文件摘要。`).join('\n');
  progress.append(logLines + '\n');
  await until(window, "document.getElementById('logs').textContent.includes('依赖 249')");
  await window.webContents.executeJavaScript("document.getElementById('follow').click(); document.getElementById('logs').scrollTop=0");
  progress.append('实时新增一行\n');
  await until(window, "document.getElementById('logs').textContent.includes('实时新增一行')");
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('logs').scrollTop"), 0);
  for (const [width, height] of [[1280, 800], [960, 640], [600, 600]]) {
    window.setSize(width, height);
    await delay(300);
    const layout = await window.webContents.executeJavaScript(`(() => {
      const log = document.getElementById('logs').getBoundingClientRect();
      return { width: innerWidth, body: document.body.scrollWidth, bottom: document.body.scrollHeight, height: innerHeight,
        logHeight: log.height, percent: document.getElementById('percent').textContent,
        bar: document.getElementById('progress').value, environment: document.getElementById('environment').textContent };
    })()`);
    assert.ok(layout.body <= layout.width && layout.bottom <= layout.height, JSON.stringify(layout));
    assert.ok(layout.logHeight > 120);
    assert.equal(layout.percent, '50%');
    assert.equal(layout.bar, 50);
    assert.ok(layout.environment.includes('.venv'));
    await fs.writeFile(path.join(app.getPath('userData'), `startup-${width}.png`), (await window.webContents.capturePage()).toPNG());
  }
  progress.fail('测试下载中断');
  await until(window, "document.body.dataset.status === 'failed' && document.getElementById('logs').textContent.includes('测试下载中断')");
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('progress').value"), 50);
  progress.report('正在重试下载…', 32);
  await until(window, "document.body.dataset.status === 'running'");
  const other = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../preload.js'), sandbox: true } });
  await other.loadFile(path.resolve(__dirname, '../startup.html'));
  assert.equal(await other.webContents.executeJavaScript("window.yabStartup.get().then(() => false, () => true)"), true);
  other.destroy();
  await window.loadURL('data:text/html,<html><body>failed backend navigation</body></html>');
  assert.equal(await window.webContents.executeJavaScript('typeof window.yabStartup'), 'undefined');
  progress.fail('测试主界面加载失败');
  await window.loadFile(path.resolve(__dirname, '../startup.html'));
  await until(window, "document.body.dataset.status === 'failed' && document.getElementById('logs').textContent.includes('测试主界面加载失败')");
  progress.complete();
  await until(window, "document.getElementById('progress').value === 100");
  // The same main window loses the bridge after navigating off the startup page.
  await window.loadURL('data:text/html,<html><body>backend placeholder</body></html>');
  assert.equal(await window.webContents.executeJavaScript('typeof window.yabStartup'), 'undefined');
  window.destroy();
  for (const reducedMotion of [false, true]) {
    const host = new BrowserWindow({ show: false, skipTaskbar: true, autoHideMenuBar: true,
      width: 960, height: 640, backgroundColor: '#0f1115',
      webPreferences: { preload: path.resolve(__dirname, '../preload.js'), sandbox: true, contextIsolation: true,
        backgroundThrottling: false } });
    const preparation = new StartupProgress();
    const screen = await createStartupScreen(host, preparation, ipcMain);
    preparation.report('正在打开主界面…', 96);
    await assert.rejects(host.loadURL('http://127.0.0.1:1/'));
    preparation.fail('测试主界面加载失败');
    await until(screen, "document.body.dataset.status === 'failed'");
    assert.equal(host.contentView.children.length, 1);
    assert.equal(await screen.webContents.executeJavaScript('getComputedStyle(document.body).opacity'), '1');
    preparation.report('正在重新打开主界面…', 96);
    await host.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:#2b394e;color:white">主界面已加载</body></html>'));
    assert.equal(preparation.state.status, 'running');
    assert.equal(await host.webContents.executeJavaScript('typeof window.yabStartup'), 'undefined');
    assert.equal(host.contentView.children.length, 1);
    host.setSize(1000, 700);
    await delay(100);
    assert.deepEqual(host.contentView.children[0].getBounds(), { x: 0, y: 0,
      width: host.getContentBounds().width, height: host.getContentBounds().height });
    screen.webContents.debugger.attach('1.3');
    await screen.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }],
    });
    if (reducedMotion) {
      assert.equal(await screen.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
      preparation.complete();
      const reduced = await screen.webContents.executeJavaScript('window.finishStartupTransition().then(() => ({animations: document.body.getAnimations().length, opacity: getComputedStyle(document.body).opacity}))');
      assert.deepEqual(reduced, { animations: 0, opacity: '1' });
      await screen.finish();
    } else {
      // Native child views need a mapped host for compositor screenshots.
      // This isolated preview never takes keyboard focus and closes below.
      host.showInactive();
      await delay(150);
      const finishing = screen.finish();
      await until(screen, 'document.body.getAnimations().length > 0');
      const middle = await screen.webContents.executeJavaScript(`(() => {
        const fade = document.body.getAnimations()[0]; fade.pause(); fade.currentTime = 380;
        return { opacity: Number(getComputedStyle(document.body).opacity), percent: document.getElementById('progress').value,
          title: document.getElementById('title').textContent };
      })()`);
      assert.equal(middle.percent, 100);
      assert.equal(middle.title, '准备就绪');
      assert.ok(middle.opacity > 0 && middle.opacity < 1);
      const capture = await screen.webContents.debugger.sendCommand('Page.captureScreenshot', { fromSurface: false });
      const screenshot = Buffer.from(capture.data, 'base64');
      const pixel = nativeImage.createFromBuffer(screenshot).toBitmap();
      // The corner must blend the startup background with the loaded page,
      // rather than merely fading the text over an opaque startup canvas.
      for (const [channel, start, end] of [[0, 21, 78], [1, 17, 57], [2, 15, 43]]) {
        const expected = start * middle.opacity + end * (1 - middle.opacity);
        assert.ok(Math.abs(pixel[channel] - expected) < 6, `transition channel ${channel}: ${pixel[channel]} vs ${expected}`);
      }
      await fs.writeFile(path.join(app.getPath('userData'), 'startup-transition.png'), screenshot);
      await screen.webContents.executeJavaScript('document.body.getAnimations()[0].play()');
      await finishing;
    }
    assert.equal(preparation.state.status, 'complete');
    if (!screen.webContents.isDestroyed()) await new Promise(resolve => screen.webContents.once('destroyed', resolve));
    assert.equal(screen.webContents.isDestroyed(), true);
    assert.equal(host.contentView.children.length, 0);
    assert.ok(await host.webContents.executeJavaScript("document.body.textContent.includes('主界面已加载')"));
    host.destroy();
  }
  console.log('STARTUP_UI_OK ' + app.getPath('userData'));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

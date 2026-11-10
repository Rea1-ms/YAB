'use strict';
const { app, BrowserWindow, dialog, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { setTimeout: delay } = require('timers/promises');
const { showMessage } = require('../message-window.cjs');
app.setPath('userData', process.env.YAB_DIALOG_TEST_DATA);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
async function ready(window) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error('Message preview closed before becoming ready');
    if (!window.webContents.isLoading() && await window.webContents.executeJavaScript("document.querySelectorAll('button').length > 0")) return;
    await delay(30);
  }
  throw new Error('Message preview did not become ready within 10 seconds');
}
app.whenReady().then(async () => {
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
    // A loaded DOM can precede the first compositor frame on a busy desktop.
    await delay(250);
    const image = await window.webContents.capturePage(undefined, { stayHidden: true });
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
    await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
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
    await single.webContents.executeJavaScript("document.querySelector('button').click()");
    assert.equal((await next).response, 0);
    const closed = showMessage(owner, { message: '已继续使用上一版本', buttons: ['确定', '取消'] }, { show: false });
    const closing = BrowserWindow.getAllWindows().find(value => value !== owner);
    await ready(closing);
    closing.close();
    assert.equal((await closed).response, 1);
    owner.destroy();
  }
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const file = await dialog.showOpenDialog(window, { title: 'YAB-PREVIEW:file:3', properties: ['openFile'],
    filters: [{ name: 'uv', extensions: ['exe'] }] });
  fs.writeFileSync(path.join(app.getPath('userData'), 'result.json'), JSON.stringify({ file, systemDark }));
  console.log('MESSAGE_UI_OK');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

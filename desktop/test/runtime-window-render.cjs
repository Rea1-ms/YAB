'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const assert = require('assert/strict');
const { setTimeout: delay } = require('timers/promises');
const { openRuntimeWindow } = require('../runtime-window.cjs');
const { loadRuntimeSettings } = require('../runtime-settings.cjs');

app.setPath('userData', process.env.YAB_RUNTIME_UI_TEST_DATA);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
async function until(window, predicate) {
  for (let count = 0; count < 100; count++) {
    if (await window.webContents.executeJavaScript(predicate)) return;
    await delay(50);
  }
  throw new Error('设置界面等待超时：' + predicate);
}
app.whenReady().then(async () => {
  const scratch = app.getPath('userData');
  const options = { userData: scratch, configRoot: path.join(scratch, 'config'), bundle: path.join(scratch, 'bundle'),
    bundled: false, initial: true, show: false };
  const saved = openRuntimeWindow(options);
  const window = BrowserWindow.getAllWindows()[0];
  window.webContents.on('console-message', event => console.log('renderer:', event.message));
  if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await until(window, "document.getElementById('save')?.disabled === false");
  const initial = await window.webContents.executeJavaScript(`({
    path: document.getElementById('location').value,
    readonly: document.getElementById('location').readOnly,
    version: document.getElementById('tool-version').textContent,
    status: document.getElementById('status').textContent,
  })`);
  assert.ok(initial.path.endsWith('uv.exe') && initial.readonly && initial.version.startsWith('版本：'));
  assert.equal(initial.status, '');
  for (const width of [720, 580]) {
    window.setSize(width, 640);
    await window.webContents.executeJavaScript("document.getElementById('tool').value='custom'; document.getElementById('tool').dispatchEvent(new Event('change'))");
    await until(window, "!document.getElementById('save').disabled");
    const geometry = await window.webContents.executeJavaScript(`(() => {
      const status = document.querySelector('#status');
      const heading = document.querySelector('.location-heading').getBoundingClientRect();
      const label = document.querySelector('label[for="location"]').getBoundingClientRect();
      const read = () => document.querySelector('#index').getBoundingClientRect().top;
      status.textContent = '';
      const before = read();
      status.textContent = '正在检查…';
      const during = read();
      const statusRect = status.getBoundingClientRect();
      status.textContent = '这是一个较长的错误提示，用来检查窄窗口时下方设置不会移动。'.repeat(5);
      const after = read();
      const overflow = document.body.scrollWidth > innerWidth;
      status.textContent = '';
      return { before, during, after, overflow, sameLine: Math.abs(statusRect.top - label.top) < 8 && statusRect.bottom <= heading.bottom };
    })()`);
    assert.equal(geometry.before, geometry.during);
    assert.equal(geometry.before, geometry.after);
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.sameLine, true);
    const state = await window.webContents.executeJavaScript(`(() => {
      const tool = document.getElementById('tool');
      const field = document.getElementById('location');
      field.value = ${JSON.stringify('C:\\very long tools directory\\uv.exe')};
      field.dispatchEvent(new Event('input'));
      return { body: document.body.scrollWidth, width: innerWidth, enabled: !field.disabled,
        selected: tool.value, indexes: document.querySelectorAll('#index option').length,
        bundledDisabled: tool.querySelector('[value="bundled"]').disabled,
        field: { width: field.getBoundingClientRect().width, right: field.getBoundingClientRect().right } };
    })()`);
    assert.ok(state.enabled && state.bundledDisabled);
    assert.equal(state.indexes, 3);
    assert.ok(state.body <= state.width && state.field.right < state.width);
    assert.ok(state.field.width > state.width - 80);
    if (process.env.YAB_RUNTIME_UI_CAPTURE) {
      await delay(200);
      await fs.writeFile(path.join(scratch, `settings-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
  }
  await window.webContents.executeJavaScript("document.getElementById('save').click()");
  await until(window, "document.getElementById('status').classList.contains('error')");
  assert.equal((await loadRuntimeSettings(options.configRoot, scratch, false)).configured, false);
  const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
    preload: path.resolve(__dirname, '../runtime-preload.cjs') } });
  await other.loadURL('data:text/html,<html><body>untrusted page</body></html>');
  assert.equal(await other.webContents.executeJavaScript("window.runtimeSettings.get().then(() => false, () => true)"), true);
  other.destroy();
  await window.webContents.executeJavaScript("document.getElementById('detect').click()");
  await until(window, "!document.getElementById('save').disabled && document.getElementById('tool').value === 'system'");
  const detected = await window.webContents.executeJavaScript("({path: document.getElementById('location').value, readonly: document.getElementById('location').readOnly, version: document.getElementById('tool-version').textContent, status: document.getElementById('status').textContent})");
  assert.equal(detected.path, initial.path);
  assert.ok(detected.readonly && detected.version.startsWith('版本：'));
  assert.equal(detected.status, '');
  if (process.env.YAB_RUNTIME_UI_CAPTURE) {
    await fs.writeFile(path.join(scratch, 'settings-detected.png'), (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript("document.getElementById('index').value = 'tsinghua'; document.getElementById('save').click()");
  assert.equal((await saved).index, 'tsinghua');
  assert.equal((await loadRuntimeSettings(options.configRoot, scratch)).settings.uvMode, 'system');
  await fs.mkdir(path.join(options.bundle, 'toolkit'), { recursive: true });
  await fs.copyFile(detected.path, path.join(options.bundle, 'toolkit/uv.exe'));
  const editing = openRuntimeWindow({ ...options, bundled: true, initial: false });
  const editWindow = BrowserWindow.getAllWindows()[0];
  if (editWindow.webContents.isLoading()) await new Promise(resolve => editWindow.webContents.once('did-finish-load', resolve));
  await until(editWindow, "document.getElementById('save')?.disabled === false");
  assert.equal(await editWindow.webContents.executeJavaScript("document.getElementById('index').value"), 'tsinghua');
  assert.equal(await editWindow.webContents.executeJavaScript("document.getElementById('save').textContent"), '保存');
  await editWindow.webContents.executeJavaScript("document.getElementById('tool').value='bundled'; document.getElementById('tool').dispatchEvent(new Event('change'))");
  await until(editWindow, "!document.getElementById('save').disabled");
  assert.equal(await editWindow.webContents.executeJavaScript("document.getElementById('location').value"), path.join(options.bundle, 'toolkit/uv.exe'));
  await editWindow.webContents.executeJavaScript("document.getElementById('tool').value='custom'; document.getElementById('tool').dispatchEvent(new Event('change'))");
  await until(editWindow, "!document.getElementById('save').disabled");
  assert.equal(await editWindow.webContents.executeJavaScript("document.getElementById('location').value"), '');
  await editWindow.webContents.executeJavaScript(`document.getElementById('location').value=${JSON.stringify(detected.path)}; document.getElementById('location').dispatchEvent(new Event('input')); document.getElementById('tool').value='system'; document.getElementById('tool').dispatchEvent(new Event('change'))`);
  await until(editWindow, "!document.getElementById('save').disabled");
  await editWindow.webContents.executeJavaScript("document.getElementById('tool').value='custom'; document.getElementById('tool').dispatchEvent(new Event('change'))");
  await until(editWindow, "!document.getElementById('save').disabled");
  assert.equal(await editWindow.webContents.executeJavaScript("({path: document.getElementById('location').value, readonly: document.getElementById('location').readOnly}).readonly"), false);
  assert.equal(await editWindow.webContents.executeJavaScript("document.getElementById('location').value"), detected.path);
  editWindow.close();
  assert.equal(await editing, null);
  console.log('RUNTIME_UI_OK ' + scratch);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '../..');
const scratch = process.env.YAB_PUSH_TEST_DATA;
app.setPath('userData', path.join(scratch, 'browser'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let backend;
let window;

async function main() {
  await app.whenReady();
  let logs = '';
  const url = await new Promise((resolve, reject) => {
    backend = spawn(path.join(root, '.venv/Scripts/python.exe'),
      ['-B', path.join(root, 'develop_tools/test/push_ui_server.py'), scratch],
      { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
    for (const stream of [backend.stdout, backend.stderr]) {
      stream.on('data', data => {
        logs += data.toString();
        const match = logs.match(/PUSH_UI_URL=(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
    }
    backend.once('error', reject);
    backend.once('exit', code => reject(new Error(`Backend exited ${code}: ${logs}`)));
  });
  for (let count = 0; count < 100; count++) {
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch {}
    await sleep(30);
  }
  window = new BrowserWindow({ width: 1440, height: 1000, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const run = source => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let count = 0; count < 150; count++) {
      if (await run(source)) return;
      await sleep(30);
    }
    throw new Error('UI condition timed out: ' + source + '\n' + errors.join('\n'));
  }
  async function click(label) {
    await run(`Array.from(document.querySelectorAll('.push-settings button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await sleep(40);
  }
  async function input(selector, value, event = 'input') {
    await run(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
    await sleep(20);
  }
  async function saved() {
    return JSON.parse(await fs.readFile(path.join(scratch, 'config/account/config.json'), 'utf8')).push_onepush;
  }

  await window.loadURL(`${url}/#/account/settings`);
  await waitFor('document.querySelector("#push-provider-0")?.options.length === 18');
  assert.equal(await run('document.querySelector("#push-0-token").value'), 'offline-ui-token');
  assert.equal(await run('document.querySelector("#push-proxy-0").value'), 'http://127.0.0.1:1080');
  await click('添加渠道');
  await input('#push-provider-1', 'lark', 'change');
  await input('#push-1-webhook', 'https://notify.invalid/offline-hook');
  // Test and save both use the visible draft, without sending outside the fixture.
  await run('document.querySelectorAll(".push-channel")[1].querySelector(":scope > button").click()');
  await waitFor('Array.from(document.querySelectorAll(".toast")).some(item => item.textContent.includes("推送成功"))');
  assert.equal(JSON.parse(await fs.readFile(path.join(scratch, 'deliveries.json'), 'utf8')).length, 1);
  assert.equal((await saved()).length, 1, 'testing a draft must not save it');
  await click('保存推送设置');
  await waitFor('document.querySelector(".push-actions .primary").disabled');
  assert.equal((await saved()).length, 2);

  // Invalid JSON stays in the form and never overwrites saved channels.
  await run('(() => { const input = document.querySelectorAll(".push-channel textarea")[1]; input.value = "{"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await click('保存推送设置');
  assert.equal((await saved()).length, 2);
  await run('(() => { const input = document.querySelectorAll(".push-channel textarea")[1]; input.value = "{}"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await click('保存推送设置');
  await waitFor('document.querySelector(".push-actions .primary").disabled');

  const measurements = [];
  for (const width of [1440, 900]) {
    window.setSize(width, 1000);
    await sleep(100);
    const measured = await run(`(() => {
      const card = document.querySelector('.push-settings');
      const rect = card.getBoundingClientRect();
      const controls = [...card.querySelectorAll('input, select, textarea')].filter(item => item.getBoundingClientRect().width);
      return { width: innerWidth, cardWidth: rect.width, overflow: card.scrollWidth - card.clientWidth,
        controlsContained: controls.every(item => { const bounds = item.getBoundingClientRect(); return bounds.left >= rect.left && bounds.right <= rect.right + 1; }) };
    })()`);
    assert.ok(measured.overflow <= 1, JSON.stringify(measured));
    assert.ok(measured.controlsContained, JSON.stringify(measured));
    measurements.push(measured);
  }

  await click('移除渠道');
  await click('移除渠道');
  await click('保存推送设置');
  await waitFor('document.querySelector(".push-actions .primary").disabled');
  assert.deepEqual(await saved(), []);
  await window.webContents.reload();
  await waitFor('document.querySelector(".push-settings .empty")?.textContent.includes("尚未配置推送渠道")');
  assert.equal(await run('document.querySelectorAll(".push-channel").length'), 0);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(scratch, 'result.json'), JSON.stringify({ measurements, mockDeliveries: 1 }, null, 2));
  console.log('PUSH_SETTINGS_OK ' + JSON.stringify(measurements));
}

main().then(() => {
  backend?.kill();
  window?.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  backend?.kill();
  window?.destroy();
  app.exit(1);
});

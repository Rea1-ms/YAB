'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { BackendRecovery, attachBackendRecovery } = require('../backend-recovery.cjs');

const root = path.resolve(__dirname, '../..');
const scratch = process.env.YAB_RECOVERY_TEST_DATA;
app.setPath('userData', path.join(scratch, 'browser'));
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let backend;
let window;
let url;
let logs = '';

async function start(recovered = false) {
  let output = '';
  backend = spawn(path.join(root, '.venv/Scripts/python.exe'),
    ['-B', path.join(root, 'develop_tools/test/backend_recovery_server.py'), scratch, url ? new URL(url).port : '0'],
    { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', YAB_DESKTOP_RECOVERY: recovered ? '1' : '' } });
  await new Promise((resolve, reject) => {
    for (const stream of [backend.stdout, backend.stderr]) stream.on('data', data => {
      output += data.toString();
      logs += data.toString();
      const match = output.match(/RECOVERY_UI_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { url = match[1]; resolve(); }
    });
    backend.once('error', reject);
    backend.once('exit', code => reject(new Error(`Fixture exited ${code}: ${output}`)));
  });
  for (let count = 0; count < 100; count++) {
    try {
      const state = await (await fetch(`${url}/api/health`)).json();
      if (state.ocr_ready) return;
    } catch {}
    await sleep(40);
  }
  throw new Error('Fixture not ready: ' + output);
}

async function main() {
  await app.whenReady();
  await start();
  window = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { preload: path.join(root, 'desktop/preload.js'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const recovery = new BackendRecovery({ restart: async () => { await gate; await start(true); } });
  attachBackendRecovery(ipcMain, { recovery, getWindow: () => window, pageUrl: () => url });
  const run = source => window.webContents.executeJavaScript(source);
  async function until(source) {
    for (let count = 0; count < 400; count++) {
      if (await run(source)) return;
      await sleep(40);
    }
    throw new Error('UI timed out: ' + source + '\n' + await run('document.body.innerText') + logs);
  }
  await window.loadURL(`${url}/#/account/home`);
  await until('document.querySelector(".big-btn")?.textContent.trim() === "停止"');
  await until('document.querySelector(".log-body")?.textContent.includes("模拟任务已启动")');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(scratch, 'starts.json'), 'utf8')), ['account', 'second']);
  await new Promise(resolve => { backend.once('exit', resolve); backend.kill(); });
  const recovering = recovery.recover({ code: 3221225477, signal: null }, 'isolated backend exit');
  await until('document.querySelector(".big-btn")?.textContent.trim() === "启动" && document.querySelector(".big-btn").disabled');
  await until('document.querySelector(".log-body")?.textContent.includes("3221225477")');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  release();
  await recovering;
  await until('document.querySelector(".big-btn")?.textContent.trim() === "启动" && !document.querySelector(".big-btn").disabled');
  assert.equal(await run('document.querySelector(".log-body").textContent.includes("模拟任务已启动")'), true);
  assert.equal(await run('document.querySelector(".log-body").textContent.includes("3221225477")'), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(scratch, 'starts.json'), 'utf8')), ['account', 'second']);
  await run('document.querySelector(".big-btn").click()');
  await until('document.querySelector(".big-btn")?.textContent.trim() === "停止"');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(scratch, 'starts.json'), 'utf8')), ['account', 'second', 'account']);
  await run('location.hash = "#/second/home"');
  await until('document.querySelector(".big-btn")?.textContent.trim() === "启动"');
  await window.webContents.reload();
  await until('document.querySelector(".log-body")?.textContent.includes("3221225477")');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await fs.writeFile(path.join(scratch, 'result.json'), JSON.stringify({ stoppedProfiles: 2, manualStarts: 1, crashLogRetained: true }));
  console.log('BACKEND_RECOVERY_OK');
}

main().then(() => { backend?.kill(); window?.destroy(); app.exit(0); }).catch(error => {
  console.error(error);
  backend?.kill(); window?.destroy(); app.exit(1);
});

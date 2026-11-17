'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function checkNavigation() {
  const { app, BrowserWindow } = require('electron');
  const scratch = process.env.YAB_NAV_TEST_DATA;
  app.setPath('userData', path.join(scratch, 'browser'));
  let backend;
  let window;
  let logs = '';
  try {
    await app.whenReady();
    const url = await new Promise((resolve, reject) => {
      // Reuse the isolated two-profile service; all tasks are simulated.
      backend = spawn(path.join(root, '.venv/Scripts/python.exe'),
        ['-B', path.join(root, 'develop_tools/test/backend_recovery_server.py'), scratch, '0'],
        { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
      for (const stream of [backend.stdout, backend.stderr]) stream.on('data', data => {
        logs += data.toString();
        const match = logs.match(/RECOVERY_UI_URL=(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
      backend.once('error', reject);
      backend.once('exit', code => reject(new Error(`Fixture exited ${code}: ${logs}`)));
    });
    window = new BrowserWindow({ show: false, width: 1280, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        offscreen: true, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error') errors.push(message);
    });
    const run = source => window.webContents.executeJavaScript(source);
    async function until(source) {
      for (let count = 0; count < 150; count++) {
        if (await run(source)) return;
        await sleep(30);
      }
      throw new Error(`UI timed out: ${source}\n${await run('document.body.innerText')}\n${errors.join('\n')}\n${logs}`);
    }
    async function click(selector) {
      await run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    }
    async function profileFiles() {
      const result = {};
      for (const dir of ['account', 'second']) {
        for (const name of ['config.json', 'event.json', 'switch.json']) {
          result[`${dir}/${name}`] = await fs.readFile(path.join(scratch, 'config', dir, name), 'utf8');
        }
      }
      return result;
    }

    // A nonfirst profile exposes a silent fallback to the first entry.
    await window.loadURL(`${url}/#/second/home`);
    await until('document.querySelector(".cfg-block select")?.value === "second" && document.querySelector(".big-btn")?.textContent.trim() === "停止"');
    const before = await profileFiles();
    for (const page of ['home', 'schedule', 'config', 'settings', 'advanced']) {
      await click('.global-nav a[href="#/update"]');
      await until('location.hash === "#/update" && !document.querySelector(".big-btn")');
      assert.equal(await run('document.querySelector(".cfg-block select").value'), 'second');
      assert.equal(await run('document.querySelector(".cfg-btns button:nth-child(2)").disabled'), false);
      const selector = `.nav a[href="#/second/${page}"]`;
      await until(`!!document.querySelector(${JSON.stringify(selector)})`);
      await click(selector);
      await until(`location.hash === "#/second/${page}" && !!document.querySelector(".nav a.active")`);
    }
    assert.deepEqual(await profileFiles(), before, 'Navigation must not rewrite profile files');

    // Changing the selector on the global page explicitly selects that profile.
    await click('.global-nav a[href="#/update"]');
    await until('location.hash === "#/update"');
    await run('(() => { const select = document.querySelector(".cfg-block select"); select.value = "account"; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await until('location.hash === "#/account/home" && !!document.querySelector(".big-btn")');
    await click('.global-nav a[href="#/update"]');
    await until('location.hash === "#/update"');
    assert.equal(await run('document.querySelector(".cfg-block select").value'), 'account');

    // A direct visit has no previous profile and uses the first valid entry.
    await window.webContents.reload();
    await until('document.querySelector(".cfg-block select")?.value === "account"');
    await click('.nav a[href="#/account/home"]');
    await until('location.hash === "#/account/home" && !!document.querySelector(".big-btn")');
    assert.deepEqual(await profileFiles(), before);
    assert.deepEqual(errors, []);
    console.log('CONFIG_NAVIGATION_OK');
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    backend?.kill();
    window?.destroy();
  }
}

if (process.versions.electron) {
  checkNavigation().then(code => require('electron').app.exit(code));
} else {
  const test = require('node:test');
  test('global navigation retains the selected profile without rewriting its files', { timeout: 60000 }, async () => {
    const output = path.join(root, 'develop_tools/out');
    await fs.mkdir(output, { recursive: true });
    const scratch = await fs.mkdtemp(path.join(output, 'config-navigation-'));
    const frontend = path.join(scratch, 'frontend');
    const { build } = await import('../../webapp/node_modules/vite/dist/node/index.js');
    await build({ root: path.join(root, 'webapp'), build: { outDir: frontend, emptyOutDir: false } });
    const env = { ...process.env, YAB_NAV_TEST_DATA: scratch, YAB_RECOVERY_TEST_FRONTEND: frontend };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'YAB_CONFIG_DIR', 'YAB_DATA_DIR', 'BAAS_WEBUI_TOKEN']) delete env[name];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [__filename], { env, windowsHide: true });
      let logs = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data.toString(); });
      const watchdog = setTimeout(() => { child.kill(); reject(new Error('Navigation UI timed out: ' + logs)); }, 55000);
      child.once('error', error => { clearTimeout(watchdog); reject(error); });
      child.once('exit', code => { clearTimeout(watchdog); resolve({ code, logs }); });
    });
    assert.equal(result.code, 0, result.logs);
    assert.match(result.logs, /CONFIG_NAVIGATION_OK/);
  });
}

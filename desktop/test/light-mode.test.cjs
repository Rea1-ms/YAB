'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { readWindowMode, saveWindowMode } = require('../window-mode.cjs');

test('close action defaults to asking and persists an explicit choice', async () => {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'light-mode-settings-'));
  const filename = path.join(scratch, 'desktop-settings.json');
  assert.equal(readWindowMode(filename), '询问');
  saveWindowMode(filename, '开启轻量模式');
  assert.equal(readWindowMode(filename), '开启轻量模式');
  saveWindowMode(filename, '仅关闭窗口');
  assert.equal(readWindowMode(filename), '仅关闭窗口');
  await fs.writeFile(filename, '{"closeAction":"invalid"}');
  assert.throws(() => readWindowMode(filename), /设置不合法/);
});

test('real windows release renderers and restore once while the service keeps running', { timeout: 90000 }, async () => {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'light-mode-ui-'));
  const { build } = await import('../../webapp/node_modules/vite/dist/node/index.js');
  const frontend = path.join(scratch, 'frontend');
  await build({ root: path.resolve(__dirname, '../../webapp'),
    build: { outDir: frontend, emptyOutDir: false } });
  const env = { ...process.env, YAB_LIGHT_MODE_TEST_DATA: scratch, YAB_LIGHT_MODE_FRONTEND: frontend };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(__dirname, 'light-mode-render.cjs')],
      { env, windowsHide: true });
    let logs = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8'); stream.on('data', text => { logs += text; });
    }
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('轻量模式检查超时：' + logs)); }, 75000);
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('exit', code => { clearTimeout(watchdog); resolve({ code, logs }); });
  });
  assert.equal(result.code, 0, result.logs);
  assert.match(result.logs, /LIGHT_MODE_OK/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { BackendRecovery, attachBackendRecovery } = require('../backend-recovery.cjs');

test('a crashed backend is restored once and tasks remain stopped', async () => {
  let finish;
  let calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const recovery = new BackendRecovery({ restart: () => { calls++; return gate; } });
  const pending = recovery.recover({ code: 3221225477, signal: null }, 'native failure tail');
  assert.equal(recovery.recover({ code: 1 }, ''), pending);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(recovery.snapshot().recovering, true);
  assert.match(recovery.snapshot().logs[0].m, /3221225477.*所有任务已停止/s);
  finish();
  await pending;
  const snapshot = recovery.snapshot();
  assert.equal(snapshot.recovering, false);
  assert.match(snapshot.logs.at(-1).m, /任务保持停止/);
  snapshot.logs.length = 0;
  assert.equal(recovery.snapshot().logs.length, 2);
});

test('failed recovery stays visible without a retry loop and shutdown never restarts', async () => {
  let calls = 0;
  const recovery = new BackendRecovery({ restart: async () => { calls++; throw new Error('fixture failure'); } });
  await recovery.recover({ code: 1 }, 'tail');
  assert.equal(calls, 1);
  assert.equal(recovery.snapshot().recovering, false);
  assert.match(recovery.snapshot().logs.at(-1).m, /恢复失败.*fixture failure/s);
  const quitting = new BackendRecovery({ restart: () => { throw new Error('must not start'); }, isQuitting: () => true });
  await quitting.recover({ code: 1 }, '');
  assert.equal(quitting.snapshot().generation, 0);
});

test('backend diagnostics are restricted to the local main frame', async () => {
  const handlers = new Map();
  const sent = [];
  let url = 'http://127.0.0.1:22267/';
  const contents = { mainFrame: {}, getURL: () => url, send: (...args) => sent.push(args) };
  const recovery = new BackendRecovery({ restart: async () => {} });
  attachBackendRecovery({ handle: (name, fn) => handlers.set(name, fn) }, {
    recovery, getWindow: () => ({ isDestroyed: () => false, webContents: contents }),
    pageUrl: () => 'http://127.0.0.1:22267/',
  });
  const get = handlers.get('yab-backend:get');
  assert.equal(get({ sender: contents, senderFrame: contents.mainFrame }).generation, 0);
  assert.throws(() => get({ sender: contents, senderFrame: {} }), /无效/);
  url = 'http://example.invalid/';
  assert.throws(() => get({ sender: contents, senderFrame: contents.mainFrame }), /无效/);
  await recovery.recover({ code: 1 }, 'private diagnostic');
  assert.equal(sent.length, 0);
});

test('real webpage retains crash logs, stops profiles and permits manual restart', { timeout: 60000 }, async () => {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'backend-recovery-ui-'));
  const { build } = await import('../../webapp/node_modules/vite/dist/node/index.js');
  const frontend = path.join(scratch, 'frontend');
  await build({ root: path.resolve(__dirname, '../../webapp'), build: { outDir: frontend, emptyOutDir: false } });
  const env = { ...process.env, YAB_RECOVERY_TEST_DATA: scratch, YAB_RECOVERY_TEST_FRONTEND: frontend };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(__dirname, 'backend-recovery-render.cjs')], { env, windowsHide: true });
    let logs = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs += data.toString(); });
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('Recovery UI timed out: ' + logs)); }, 55000);
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('exit', code => { clearTimeout(watchdog); resolve({ code, logs }); });
  });
  assert.equal(result.code, 0, result.logs);
  assert.match(result.logs, /BACKEND_RECOVERY_OK/);
});

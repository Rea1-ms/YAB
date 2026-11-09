'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('notification form migrates, saves, tests and removes channels over real WebSocket', { timeout: 60000 }, async () => {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'onepush-ui-'));
  const env = { ...process.env, YAB_PUSH_TEST_DATA: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(__dirname, 'push-settings-render.cjs')],
      { env, windowsHide: true });
    let logs = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', text => { logs += text.toString(); });
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('Notification UI timed out: ' + logs)); }, 55000);
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('exit', code => { clearTimeout(watchdog); resolve({ code, logs }); });
  });
  assert.equal(result.code, 0, result.logs);
  assert.match(result.logs, /PUSH_SETTINGS_OK/);
});

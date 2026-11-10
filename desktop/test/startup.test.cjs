'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { StartupProgress } = require('../startup.cjs');

test('startup progress survives retries and failures without claiming success', () => {
  const progress = new StartupProgress();
  progress.report('安装依赖', 50);
  progress.fail('下载中断');
  assert.equal(progress.snapshot().status, 'failed');
  assert.equal(progress.snapshot().percent, 50);
  progress.report('重新校验', 2);
  assert.equal(progress.snapshot().status, 'running');
  assert.equal(progress.snapshot().percent, 50);
  progress.report('等待服务', 100);
  assert.equal(progress.snapshot().percent, 99);
  progress.complete();
  assert.equal(progress.snapshot().percent, 100);
  const completed = progress.snapshot();
  progress.append('后续运行日志');
  progress.report('过期事件', 5);
  assert.deepEqual(progress.snapshot(), completed);
});

test('startup log preserves chunked lines and bounds noisy subprocess output', () => {
  const progress = new StartupProgress();
  progress.append('\x1b[32m正在下');
  progress.append('载\x1b[0m\r完成\r\n');
  assert.equal(progress.snapshot().logText, '正在下载\n完成\n');
  progress.append('x'.repeat(200000));
  assert.ok(progress.snapshot().logText.length <= 120000);
  progress.append('\n' + Array.from({ length: 600 }, (_, index) => `日志 ${index}`).join('\n'));
  assert.ok(progress.snapshot().logText.split('\n').length <= 500);
  assert.ok(progress.snapshot().logText.endsWith('日志 599'));
  const snapshot = progress.snapshot();
  snapshot.message = '外部修改';
  assert.notEqual(progress.snapshot().message, snapshot.message);
});

test('real startup page streams logs, restricts access and fades into the loaded application', { timeout: 60000 }, async () => {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'startup-ui-'));
  const env = { ...process.env, YAB_STARTUP_UI_TEST_DATA: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(__dirname, 'startup-render.cjs')], { env, windowsHide: true });
    let logs = '';
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', text => { logs += text; }); }
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('启动界面检查超时：' + logs)); }, 50000);
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('exit', code => { clearTimeout(watchdog); resolve({ code, logs }); });
  });
  assert.equal(result.code, 0, result.logs);
  assert.match(result.logs, /STARTUP_UI_OK/);
});

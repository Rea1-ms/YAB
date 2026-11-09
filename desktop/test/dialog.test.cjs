'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

test('desktop messages render both themes, preserve results and theme system file browsing', {
  skip: process.platform !== 'win32',
}, async t => {
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/shell-dialog-'));
  for (const theme of ['dark', 'light']) {
    const data = path.join(scratch, theme);
    await fs.mkdir(data);
    const env = { ...process.env, YAB_DIALOG_TEST_DATA: data, YAB_DIALOG_TEST_THEME: theme };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable = require('electron');
    const preview = spawn(executable, [path.join(__dirname, 'dialog-render.cjs')], { env, windowsHide: true, timeout: 35000 });
    let output = '';
    preview.stdout.on('data', chunk => { output += chunk; });
    preview.stderr.on('data', chunk => { output += chunk; });
    const finished = new Promise((resolve, reject) => {
      preview.once('error', reject);
      preview.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const pixels = path.join(data, 'pixels.json');
    const probe = spawnSync('pwsh.exe', ['-NoProfile', '-File', path.join(__dirname, 'native-dialog-probe.ps1'),
      '-PreviewProcessId', String(preview.pid), '-Executable', executable, '-ReportPath', pixels, '-Kind', 'shell'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert.deepEqual(await finished, { code: 0, signal: null }, output);
    assert.match(output, /MESSAGE_UI_OK/);
    const results = JSON.parse(await fs.readFile(path.join(data, 'result.json'), 'utf8'));
    assert.equal(results.file.canceled, true);
    const samples = JSON.parse((await fs.readFile(pixels, 'utf8')).replace(/^\uFEFF/, ''));
    assert.equal(samples.length, 1);
    for (const sample of samples) for (const color of [sample.Body, sample.Footer]) {
      assert.notEqual(color, -1);
      const channels = [color & 255, (color >> 8) & 255, (color >> 16) & 255];
      assert.ok(channels.every(value => results.systemDark ? value < 100 : value > 150), JSON.stringify(sample));
    }
  }
  t.diagnostic(`Desktop message and file dialog previews: ${scratch}`);
});

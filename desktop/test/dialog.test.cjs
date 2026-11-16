'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

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
    t.after(() => { if (preview.exitCode === null && preview.signalCode === null) preview.kill(); });
    let output = '';
    let openShell;
    const shellReady = new Promise(resolve => { openShell = resolve; });
    const collect = chunk => {
      output += chunk;
      if (output.includes('MESSAGE_SHELL_READY')) openShell();
    };
    preview.stdout.on('data', collect);
    preview.stderr.on('data', collect);
    const finished = new Promise((resolve, reject) => {
      preview.once('error', reject);
      preview.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Compile the native probe only after the hidden Chromium checks finish.
    // Keep draining renderer diagnostics while both processes are running.
    await Promise.race([shellReady, finished.then(result => {
      throw new Error(`Message preview exited before the file dialog: ${JSON.stringify(result)}\n${output}\nPreview data: ${data}`);
    })]);
    const pixels = path.join(data, 'pixels.json');
    const probe = spawn('pwsh.exe', ['-NoProfile', '-File', path.join(__dirname, 'native-dialog-probe.ps1'),
      '-PreviewProcessId', String(preview.pid), '-Executable', executable, '-ReportPath', pixels, '-Kind', 'shell'],
    { windowsHide: true, timeout: 30000 });
    t.after(() => { if (probe.exitCode === null && probe.signalCode === null) probe.kill(); });
    let probeOutput = '';
    for (const stream of [probe.stdout, probe.stderr]) stream.on('data', chunk => { probeOutput += chunk; });
    const probeFinished = new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.once('close', (code, signal) => resolve({ code, signal }));
    });
    const [result, probeResult] = await Promise.all([finished, probeFinished]);
    assert.deepEqual(result, { code: 0, signal: null }, output + `\nPreview data: ${data}`);
    assert.deepEqual(probeResult, { code: 0, signal: null }, probeOutput);
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

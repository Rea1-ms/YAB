'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const newTestDirectory = require('./output.cjs').testDirectories(['settings-*.png']);

test('runtime settings render at both widths, locate tools, save choices and reject other windows', async () => {
  const env = { ...process.env };
  env.YAB_RUNTIME_UI_TEST_DATA = await newTestDirectory('runtime-ui-');
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'runtime-window-render.cjs')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n');
  assert.ok(!result.error, output);
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /RUNTIME_UI_OK/);
});

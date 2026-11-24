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
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RUNTIME_UI_OK/);
});

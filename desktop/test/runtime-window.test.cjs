'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

test('runtime settings render at both widths, locate tools, save choices and reject other windows', () => {
  const env = { ...process.env };
  const output = path.resolve(__dirname, '../../develop_tools/out');
  fs.mkdirSync(output, { recursive: true });
  env.YAB_RUNTIME_UI_TEST_DATA = fs.mkdtempSync(path.join(output, 'runtime-ui-'));
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'runtime-window-render.cjs')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RUNTIME_UI_OK/);
});

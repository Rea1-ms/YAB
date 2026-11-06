'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

test('bundled help renders on a dark canvas in hidden Chromium', () => {
  const env = { ...process.env };
  const output = path.resolve(__dirname, '../../develop_tools/out');
  fs.mkdirSync(output, { recursive: true });
  env.YAB_HELP_TEST_DATA = fs.mkdtempSync(path.join(output, 'help-render-'));
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'help-render.cjs')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /HELP_RENDER_OK/);
});

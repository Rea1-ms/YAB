'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const newTestDirectory = require('./output.cjs').testDirectories();

test('bundled help renders on a dark canvas in hidden Chromium', async () => {
  const env = { ...process.env };
  env.YAB_HELP_TEST_DATA = await newTestDirectory('help-render-');
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'help-render.cjs')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /HELP_RENDER_OK/);
});

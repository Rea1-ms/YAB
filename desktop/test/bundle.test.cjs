'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

test('lightweight bundles omit offline resources and only dependency changes invalidate environments', () => {
  const root = path.resolve(__dirname, '../..');
  const python = process.env.BAAS_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-B', path.join(__dirname, 'bundle_test.py')], {
    cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

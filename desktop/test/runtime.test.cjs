'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { prepareRuntime } = require('../runtime.cjs');

test('initial install and upgrade preserve user configs and OCR settings', async () => {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'desktop-runtime-'));
  const bundle = path.join(scratch, 'bundled');
  const data = path.join(scratch, 'user-data');
  await fs.mkdir(bundle);
  await fs.writeFile(path.join(bundle, 'bundle.json'), JSON.stringify({ id: 'v1' }));
  await fs.writeFile(path.join(bundle, 'BAAS.exe'), 'backend v1');
  const root = await prepareRuntime(bundle, data);
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'account.json'), 'my settings');
  const ocrConfig = 'core/ocr/baas_ocr_client/bin/config';
  await fs.mkdir(path.join(root, ocrConfig), { recursive: true });
  await fs.writeFile(path.join(root, ocrConfig, 'global_setting.json'), 'my OCR settings');
  await fs.mkdir(path.join(bundle, ocrConfig), { recursive: true });
  await fs.writeFile(path.join(bundle, ocrConfig, 'global_setting.json'), 'must not replace');
  await fs.mkdir(path.join(bundle, 'config'));
  await fs.writeFile(path.join(bundle, 'config', 'account.json'), 'must not replace');
  await fs.writeFile(path.join(bundle, 'setup.toml'), 'must not copy');
  await fs.writeFile(path.join(bundle, 'error.log'), 'must not copy');
  await fs.writeFile(path.join(bundle, 'BAAS.exe'), 'backend v2');
  await fs.writeFile(path.join(bundle, 'bundle.json'), JSON.stringify({ id: 'v2' }));
  assert.equal(await prepareRuntime(bundle, data), root);
  assert.equal(await fs.readFile(path.join(root, 'BAAS.exe'), 'utf8'), 'backend v2');
  assert.equal(await fs.readFile(path.join(root, 'config', 'account.json'), 'utf8'), 'my settings');
  assert.equal(await fs.readFile(path.join(root, ocrConfig, 'global_setting.json'), 'utf8'), 'my OCR settings');
  await assert.rejects(fs.access(path.join(root, 'setup.toml')));
  await assert.rejects(fs.access(path.join(root, 'error.log')));
  // Starting the same version again must not overwrite mutable runtime files.
  await fs.writeFile(path.join(root, 'BAAS.exe'), 'runtime sentinel');
  await prepareRuntime(bundle, data);
  assert.equal(await fs.readFile(path.join(root, 'BAAS.exe'), 'utf8'), 'runtime sentinel');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');
const { desktopDataPath, prepareRuntime, activateRuntime, readActiveRuntime, restoreSettings } = require('../runtime.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const ocr = 'core/ocr/baas_ocr_client/bin';

async function fixture() {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'desktop-runtime-'));
  const bundle = path.join(scratch, 'bundled');
  const data = path.join(scratch, 'user-data');
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'venv') {
      const python = path.join(args.at(-1), 'Scripts/python.exe');
      await fs.mkdir(path.dirname(python), { recursive: true });
      await fs.writeFile(python, 'test interpreter');
    }
  };
  const writeBundle = async (version, dependency = 'deps-v1') => {
    const content = { 'app/server/__main__.py': version, 'app/webapp/dist/index.html': 'html',
      'app/distribution.json': '{}', [`app/${ocr}/BAAS_ocr_server.exe`]: 'ocr',
      'toolkit/python/python.exe': 'standalone python', 'toolkit/uv.exe': 'uv',
      'requirements.txt': dependency, 'wheels/package.whl': dependency };
    const files = {};
    for (const [name, text] of Object.entries(content)) {
      await fs.mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
      await fs.writeFile(path.join(bundle, name), text);
      files[name] = hash(text);
    }
    await fs.writeFile(path.join(bundle, 'bundle.json'), JSON.stringify({
      format: 2, id: hash(version + dependency), version, runtimeKey: hash(dependency), files,
    }));
  };
  await writeBundle('v1');
  return { bundle, data, calls, run, writeBundle };
}

test('upgrade isolates source versions, reuses dependencies and preserves legacy settings', async () => {
  const f = await fixture();
  const config = path.join(f.data, 'backend/config/account.json');
  const ocrConfig = path.join(f.data, 'backend', ocr, 'config/global_setting.json');
  for (const file of [config, ocrConfig]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'my settings');
  }
  const v1 = await prepareRuntime(f.bundle, f.data, f);
  assert.ok(path.basename(path.dirname(path.dirname(path.dirname(v1.python)))).length < 40);
  assert.ok(path.basename(v1.root).length < 40);
  assert.equal(await readActiveRuntime(f.data), null);
  await activateRuntime(f.data, v1);
  await fs.writeFile(path.join(v1.root, 'removed-module.py'), 'obsolete');
  // Unlisted mutable files must never be copied, even from a dirty bundle.
  await fs.mkdir(path.join(f.bundle, 'app/config'));
  await fs.writeFile(path.join(f.bundle, 'app/config/account.json'), 'must not copy');
  await fs.writeFile(path.join(f.bundle, 'app/setup.toml'), 'private');
  await f.writeBundle('v2');
  const v2 = await prepareRuntime(f.bundle, f.data, f);
  assert.notEqual(v2.root, v1.root);
  assert.equal(v2.python, v1.python);
  assert.equal(f.calls.filter(call => call.args[0] === 'venv').length, 1);
  assert.equal(await fs.readFile(path.join(v2.root, 'config/account.json'), 'utf8'), 'my settings');
  assert.equal(await fs.readFile(path.join(v2.root, ocr, 'config/global_setting.json'), 'utf8'), 'my settings');
  await assert.rejects(fs.access(path.join(v2.root, 'removed-module.py')));
  await assert.rejects(fs.access(path.join(v2.root, 'setup.toml')));
  assert.equal((await readActiveRuntime(f.data)).id, v1.id);
  await fs.writeFile(config, 'failed migration');
  await restoreSettings(f.data, v2);
  assert.equal(await fs.readFile(config, 'utf8'), 'my settings');
  await activateRuntime(f.data, v2);
  const again = await prepareRuntime(f.bundle, f.data, f);
  assert.equal(again.root, v2.root);
  assert.equal((await fs.readdir(path.join(f.data, 'versions'))).length, 2);
});

test('renaming keeps legacy desktop data and honors explicit overrides', async () => {
  const f = await fixture();
  assert.equal(desktopDataPath(f.data), path.join(f.data, 'yab-desktop'));
  const legacy = path.join(f.data, 'baas-desktop');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'Preferences'), 'saved preferences');
  assert.equal(desktopDataPath(f.data), legacy);
  assert.equal(await fs.readFile(path.join(desktopDataPath(f.data), 'Preferences'), 'utf8'), 'saved preferences');
  const custom = path.join(f.data, 'custom');
  assert.equal(desktopDataPath(f.data, custom), custom);
});

test('installation-local settings migrate legacy data, survive upgrades and restore locally', async () => {
  const f = await fixture();
  const oldConfig = path.join(f.data, 'backend/config/account/config.json');
  const oldOcr = path.join(f.data, 'backend', ocr, 'config/global_setting.json');
  for (const file of [oldConfig, oldOcr]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'legacy settings');
  }
  const legacy = await prepareRuntime(f.bundle, f.data, f);
  await activateRuntime(f.data, legacy);
  const configRoot = path.join(f.data, '../installed/config');
  const options = { ...f, configRoot };
  const local = await prepareRuntime(f.bundle, f.data, options);
  assert.notEqual(local.root, legacy.root); // The old version is still linked to AppData.
  assert.equal(local.python, legacy.python);
  const config = path.join(configRoot, 'profiles/account/config.json');
  const localOcr = path.join(configRoot, 'ocr/global_setting.json');
  assert.equal(await fs.readFile(config, 'utf8'), 'legacy settings');
  assert.equal(await fs.readFile(localOcr, 'utf8'), 'legacy settings');
  await fs.writeFile(path.join(local.root, 'config/account/config.json'), 'local profile');
  await fs.writeFile(path.join(local.root, ocr, 'config/global_setting.json'), 'local OCR');
  assert.equal(await fs.readFile(oldConfig, 'utf8'), 'legacy settings');
  assert.equal(await fs.readFile(oldOcr, 'utf8'), 'legacy settings');
  assert.equal(await fs.readFile(config, 'utf8'), 'local profile');
  await activateRuntime(f.data, local);
  assert.equal((await prepareRuntime(f.bundle, f.data, options)).root, local.root);
  await f.writeBundle('v2');
  const v2 = await prepareRuntime(f.bundle, f.data, options);
  assert.equal(v2.python, local.python);
  assert.equal(await fs.readFile(path.join(v2.root, 'config/account/config.json'), 'utf8'), 'local profile');
  await fs.writeFile(config, 'failed migration');
  await fs.writeFile(localOcr, 'failed OCR migration');
  await restoreSettings(f.data, v2);
  assert.equal(await fs.readFile(config, 'utf8'), 'local profile');
  assert.equal(await fs.readFile(localOcr, 'utf8'), 'local OCR');
  assert.equal(await fs.readFile(oldConfig, 'utf8'), 'legacy settings');
});

test('existing installation settings take precedence and a new location imports current settings', async () => {
  const f = await fixture();
  const configRoot = path.join(f.data, '../installed/config');
  const config = path.join(configRoot, 'profiles/account/config.json');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, 'existing local settings');
  const local = await prepareRuntime(f.bundle, f.data, { ...f, configRoot });
  await activateRuntime(f.data, local);
  const newRoot = path.join(f.data, '../second-install/config');
  const next = await prepareRuntime(f.bundle, f.data, { ...f, configRoot: newRoot });
  assert.notEqual(next.root, local.root);
  assert.equal(await fs.readFile(path.join(newRoot, 'profiles/account/config.json'), 'utf8'), 'existing local settings');
  assert.equal(await fs.readFile(config, 'utf8'), 'existing local settings');
});

test('unusable configuration location fails clearly without executing tools or replacing active state', async () => {
  const f = await fixture();
  const v1 = await prepareRuntime(f.bundle, f.data, f);
  await activateRuntime(f.data, v1);
  const configRoot = path.join(f.data, 'blocked-config');
  await fs.writeFile(configRoot, 'this is a file');
  f.calls.length = 0;
  await assert.rejects(prepareRuntime(f.bundle, f.data, { ...f, configRoot }), /无法准备配置目录.*YAB_CONFIG_DIR/);
  assert.equal(f.calls.length, 0);
  assert.equal((await readActiveRuntime(f.data)).root, v1.root);
});

test('configuration imports recover from a temporary Windows lock without changing old settings', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture();
  const original = path.join(f.data, 'backend/config/account/config.json');
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.writeFile(original, 'legacy settings');
  const rename = fs.rename;
  let blocked = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!blocked && path.basename(from).startsWith('.import-')) {
      blocked = true;
      throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  const configRoot = path.join(f.data, '../installed/config');
  const runtime = await prepareRuntime(f.bundle, f.data, { ...f, configRoot });
  assert.equal(blocked, true);
  assert.equal(await fs.readFile(path.join(runtime.root, 'config/account/config.json'), 'utf8'), 'legacy settings');
  assert.equal(await fs.readFile(original, 'utf8'), 'legacy settings');
});

test('a persistent Windows import lock leaves the old active version and settings intact', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await fixture();
  const original = path.join(f.data, 'backend/config/account/config.json');
  await fs.mkdir(path.dirname(original), { recursive: true });
  await fs.writeFile(original, 'legacy settings');
  const previous = await prepareRuntime(f.bundle, f.data, f);
  await activateRuntime(f.data, previous);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith('.import-')) {
      throw Object.assign(new Error('permanently locked'), { code: 'EACCES' });
    }
    return rename(from, to);
  });
  const configRoot = path.join(f.data, '../installed/config');
  f.calls.length = 0;
  await assert.rejects(prepareRuntime(f.bundle, f.data, { ...f, configRoot }), /无法准备配置目录/);
  assert.equal((await readActiveRuntime(f.data)).root, previous.root);
  assert.equal(await fs.readFile(original, 'utf8'), 'legacy settings');
  assert.equal(f.calls.length, 0);
});

test('dependency change creates an environment; failed install leaves active version usable', async () => {
  const f = await fixture();
  const v1 = await prepareRuntime(f.bundle, f.data, f);
  await activateRuntime(f.data, v1);
  await f.writeBundle('v2', 'deps-v2');
  await assert.rejects(prepareRuntime(f.bundle, f.data, { run: async () => { throw new Error('install failed'); } }), /install failed/);
  assert.equal((await readActiveRuntime(f.data)).root, v1.root);
  const v2 = await prepareRuntime(f.bundle, f.data, f);
  assert.notEqual(v2.python, v1.python);
  for (const call of f.calls.filter(call => call.args[0] === 'pip' && call.args[1] === 'sync')) {
    assert.ok(call.args.includes('--offline'));
    assert.ok(call.args.includes('--no-index'));
    assert.ok(call.args.includes('--require-hashes'));
    assert.equal(call.options.env.UV_PYTHON_DOWNLOADS, 'never');
  }
});

test('corrupt offline content is rejected before any executable runs', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.bundle, 'wheels/package.whl'), 'corrupt');
  await assert.rejects(prepareRuntime(f.bundle, f.data, f), /校验失败/);
  assert.equal(f.calls.length, 0);
  assert.equal(await readActiveRuntime(f.data), null);
});

test('manifest traversal is rejected before executing a package', async () => {
  const f = await fixture();
  const file = path.join(f.bundle, 'bundle.json');
  const manifest = JSON.parse(await fs.readFile(file));
  manifest.files['app/../../outside'] = hash('outside');
  await fs.writeFile(file, JSON.stringify(manifest));
  await assert.rejects(prepareRuntime(f.bundle, f.data, f), /不合法/);
  assert.equal(f.calls.length, 0);
});

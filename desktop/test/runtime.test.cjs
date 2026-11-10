'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { createHash } = require('crypto');
const { desktopDataPath, prepareRuntime, activateRuntime, readActiveRuntime, restoreSettings } = require('../runtime.cjs');
const { INDEXES, loadRuntimeSettings, saveRuntimeSettings, validateSettings, runtimeEnvironment } = require('../runtime-settings.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const ocr = 'core/ocr/baas_ocr_client/bin';

async function fixture({ online = false, bundled = true } = {}) {
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
      'requirements.txt': dependency };
    if (!online) Object.assign(content, { 'toolkit/python/python.exe': 'standalone python', 'wheels/package.whl': dependency });
    else content['build-constraints.txt'] = 'setuptools==69.5.1\nwheel==0.45.1\n';
    if (!online || bundled) content['toolkit/uv.exe'] = 'uv';
    const files = {};
    for (const [name, text] of Object.entries(content)) {
      await fs.mkdir(path.dirname(path.join(bundle, name)), { recursive: true });
      await fs.writeFile(path.join(bundle, name), text);
      files[name] = hash(text);
    }
    await fs.writeFile(path.join(bundle, 'bundle.json'), JSON.stringify({
      format: online ? 3 : 2, id: hash(version + dependency), version, runtimeKey: hash(dependency), files,
      ...(online ? { mode: 'online', uv: bundled ? 'bundled' : 'system', python: '3.11.14' } : {}),
    }));
  };
  await writeBundle('v1');
  const selections = [];
  const resolveUv = async (settings, file) => { selections.push(settings); return settings.uvMode === 'bundled' ? file : path.join(scratch, 'system/uv.exe'); };
  return { bundle, data, calls, run, writeBundle, resolveUv, selections };
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

test('desktop data uses the YAB directory and honors explicit overrides', async () => {
  const f = await fixture();
  assert.equal(desktopDataPath(f.data), path.join(f.data, 'yab-desktop'));
  const legacy = path.join(f.data, 'baas-desktop');
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'Preferences'), 'saved preferences');
  assert.equal(desktopDataPath(f.data), path.join(f.data, 'yab-desktop'));
  assert.equal(await fs.readFile(path.join(legacy, 'Preferences'), 'utf8'), 'saved preferences');
  const custom = path.join(f.data, 'custom');
  assert.equal(desktopDataPath(f.data, custom), custom);
});

test('online and offline startup report real preparation phases and forward live output', async () => {
  for (const online of [false, true]) {
    const f = await fixture({ online });
    const updates = [];
    const logs = [];
    const progress = (message, percent) => updates.push({ message, percent });
    const run = async (command, args, options) => {
      if (args[0] === 'pip' && args[1] === 'sync') {
        assert.equal(updates.at(-1).percent, 50, 'Show installation before starting the subprocess.');
        options.output('正在安装依赖\n');
      }
      return f.run(command, args, options);
    };
    const runtime = await prepareRuntime(f.bundle, f.data, { ...f, run, progress, output: text => logs.push(text) });
    assert.ok(updates.some(update => update.percent > 2 && update.percent <= 18));
    assert.ok(updates.some(update => update.percent === 68));
    assert.ok(updates.some(update => update.percent > 74 && update.percent <= 80));
    assert.equal(updates.at(-1).percent, 82, 'The backend and page are still pending.');
    assert.ok(updates.every(update => update.percent < 100));
    assert.ok(logs.includes('正在安装依赖\n'));
    await activateRuntime(f.data, runtime);
    updates.length = 0;
    await prepareRuntime(f.bundle, f.data, { ...f, progress });
    assert.equal(updates.at(-1).percent, 82);
    assert.ok(!updates.some(update => update.percent === 50), 'An existing environment skips installation.');
  }
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

test('lightweight installation checks the shared pinned interpreter and installs hashed dependencies using the selected mirror', async () => {
  for (const index of Object.keys(INDEXES)) {
    const f = await fixture({ online: true });
    const configRoot = path.join(f.data, '../installed/config');
    await saveRuntimeSettings(configRoot, f.data, { uvMode: 'bundled', uvPath: '', index });
    const runtime = await prepareRuntime(f.bundle, f.data, { ...f, configRoot });
    const install = f.calls.find(call => call.args[0] === 'python');
    assert.equal(install.args.at(-1), '3.11.14');
    assert.ok(install.args.includes('--no-registry'));
    assert.equal(install.options.env.UV_PYTHON_INSTALL_DIR, process.env.UV_PYTHON_INSTALL_DIR);
    assert.ok(!install.args.includes('--reinstall'));
    assert.ok(!install.args.includes('--force'));
    const sync = f.calls.find(call => call.args[1] === 'sync');
    assert.equal(sync.args[sync.args.indexOf('--default-index') + 1], INDEXES[index].url);
    assert.ok(sync.args.includes('--require-hashes'));
    assert.ok(sync.args.includes('--build-constraints'));
    assert.ok(!sync.args.includes('--offline'));
    assert.ok(!sync.args.includes('--no-index'));
    assert.equal(sync.options.env.UV_OFFLINE, undefined);
    assert.ok(!f.calls.some(call => call.args.includes('wheel')));
    await activateRuntime(f.data, runtime);
    f.calls.length = 0;
    await saveRuntimeSettings(configRoot, f.data, { uvMode: 'system', uvPath: '', index: 'aliyun' });
    assert.equal((await prepareRuntime(f.bundle, f.data, { ...f, configRoot })).python, runtime.python);
    assert.equal(f.calls.length, 1); // Only the interpreter health probe runs.
  }
});

test('a system-tool lightweight package needs no bundled interpreter or uv', async () => {
  const f = await fixture({ online: true, bundled: false });
  const runtime = await prepareRuntime(f.bundle, f.data, f);
  assert.equal(f.selections[0].uvMode, 'system');
  assert.ok(f.calls.find(call => call.args[0] === 'venv').command.endsWith(path.join('system', 'uv.exe')));
  assert.equal(await fs.readFile(path.join(runtime.root, 'server/__main__.py'), 'utf8'), 'v1');
});

test('lightweight source updates reuse dependencies; dependency updates isolate failed preparations', async () => {
  const f = await fixture({ online: true });
  const first = await prepareRuntime(f.bundle, f.data, f);
  await activateRuntime(f.data, first);
  await fs.writeFile(path.join(first.root, 'config/account.json'), 'keep my settings');
  await f.writeBundle('v2');
  const second = await prepareRuntime(f.bundle, f.data, f);
  assert.equal(second.python, first.python);
  await activateRuntime(f.data, second);
  await f.writeBundle('v3', 'new dependency');
  const failingRun = async (command, args, options) => {
    if (args[1] === 'sync') throw new Error('mirror unavailable');
    return f.run(command, args, options);
  };
  await assert.rejects(prepareRuntime(f.bundle, f.data, { ...f, run: failingRun }), /mirror unavailable/);
  assert.equal((await readActiveRuntime(f.data)).root, second.root);
  assert.equal(await fs.readFile(path.join(first.root, 'config/account.json'), 'utf8'), 'keep my settings');
  const third = await prepareRuntime(f.bundle, f.data, f);
  assert.notEqual(third.python, second.python);
  assert.equal(await fs.readFile(path.join(third.root, 'config/account.json'), 'utf8'), 'keep my settings');
  assert.equal((await readActiveRuntime(f.data)).root, second.root);
});

test('corrupt lightweight content and incomplete online metadata never execute tools', async () => {
  for (const mutation of [manifest => { manifest.python = '3.13'; },
    manifest => { delete manifest.files['build-constraints.txt']; },
    manifest => { manifest.uv = 'arbitrary'; }]) {
    const f = await fixture({ online: true });
    const file = path.join(f.bundle, 'bundle.json');
    const manifest = JSON.parse(await fs.readFile(file));
    mutation(manifest);
    await fs.writeFile(file, JSON.stringify(manifest));
    await assert.rejects(prepareRuntime(f.bundle, f.data, f), /不完整|缺少/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.selections.length, 0);
  }
  const f = await fixture({ online: true });
  await fs.writeFile(path.join(f.bundle, 'toolkit/uv.exe'), 'corrupt');
  await assert.rejects(prepareRuntime(f.bundle, f.data, f), /校验失败/);
  assert.equal(f.calls.length, 0);
});

test('runtime settings persist per installation and reject unsupported indexes or relative tools', async () => {
  const f = await fixture({ online: true });
  const config = path.join(f.data, '../installed/config');
  assert.equal((await loadRuntimeSettings(config, f.data, false)).settings.uvMode, 'system');
  const selected = { uvMode: 'custom', uvPath: path.resolve('my tools/uv.exe'), index: 'tsinghua' };
  await saveRuntimeSettings(config, f.data, selected);
  assert.deepEqual((await loadRuntimeSettings(config, f.data)).settings, selected);
  assert.equal((await loadRuntimeSettings(path.join(f.data, '../another/config'), f.data)).configured, false);
  for (const value of [{ ...selected, index: 'other' }, { ...selected, uvPath: 'uv.exe' }, { ...selected, uvMode: 'other' }]) {
    assert.throws(() => validateSettings(value), /设置无效/);
  }
});

test('host uv options cannot override the selected source or make a complete package access the network', () => {
  const inherited = { PATH: 'preserved', UV_CACHE_DIR: 'shared-cache', UV_PYTHON_INSTALL_DIR: 'managed-python', UV_OFFLINE: '1', UV_NO_CACHE: '1',
    UV_NO_VERIFY_HASHES: '1', UV_INDEX: 'https://other.invalid', UV_PYTHON: 'wrong-python',
    PYTHONPATH: 'unsafe', VIRTUAL_ENV: 'wrong-env' };
  const online = runtimeEnvironment(true, 'user-data', inherited);
  assert.equal(online.UV_CACHE_DIR, 'shared-cache');
  assert.equal(online.UV_PYTHON_INSTALL_DIR, 'managed-python');
  assert.equal(runtimeEnvironment(true, 'user-data', {}).UV_PYTHON_INSTALL_DIR, undefined);
  assert.equal(online.PATH, 'preserved');
  for (const key of ['UV_OFFLINE', 'UV_NO_CACHE', 'UV_NO_VERIFY_HASHES', 'UV_INDEX', 'UV_PYTHON', 'PYTHONPATH', 'VIRTUAL_ENV']) assert.equal(online[key], undefined);
  const offline = runtimeEnvironment(false, 'user-data', inherited);
  assert.equal(offline.UV_OFFLINE, '1');
  assert.equal(offline.UV_PYTHON_DOWNLOADS, 'never');
  assert.equal(offline.UV_PYTHON_INSTALL_DIR, undefined);
});

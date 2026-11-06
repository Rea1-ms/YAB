'use strict';

const fs = require('fs/promises');
const { existsSync } = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');

const PROBE = 'import sys,starlette,uvicorn,numpy,cv2,av,adbutils,uiautomator2,win32api; '
  + 'assert sys.version_info[:2] == (3,11); print("Runtime OK")';
const PROBE_ARGS = ['-I', '-X', 'utf8', '-c', PROBE];
const OCR_CONFIG = 'core/ocr/baas_ocr_client/bin/config';

async function publishImportedSettings(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      // Windows may briefly keep newly copied files open. Retry the completed
      // import, leaving both the source settings and failed imports untouched.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
      await delay(100 * 2 ** attempt);
    }
  }
}

function settingsDirectories(userData, configRoot) {
  return [
    { relative: 'config', shared: configRoot ? path.join(configRoot, 'profiles') : path.join(userData, 'backend/config') },
    { relative: OCR_CONFIG, shared: configRoot ? path.join(configRoot, 'ocr') : path.join(userData, 'backend', OCR_CONFIG) },
  ];
}

async function prepareSettings(userData, configRoot, previousConfigRoot) {
  const directories = settingsDirectories(userData, configRoot);
  const previous = settingsDirectories(userData, previousConfigRoot);
  try {
    if (configRoot) await fs.mkdir(configRoot, { recursive: true });
    for (const { relative, shared } of directories) {
      if (!await exists(shared)) {
        const legacy = previous.find(item => item.relative === relative).shared;
        if (configRoot && await exists(legacy)) {
          // Publish only complete copies; interrupted imports remain for inspection.
          const pending = path.join(configRoot, `.import-${randomUUID()}`);
          await fs.cp(legacy, pending, { recursive: true, force: false, errorOnExist: true });
          await publishImportedSettings(pending, shared);
        } else {
          await fs.mkdir(shared, { recursive: true });
        }
      }
      if (!(await fs.stat(shared)).isDirectory()) throw new Error(`${shared} 已存在，但不是目录`);
    }
    if (configRoot) {
      await fs.writeFile(path.join(configRoot, '.desktop-layout.json'), JSON.stringify({ format: 1 }));
    }
    return directories;
  } catch (error) {
    throw new Error(`无法准备配置目录 ${configRoot || path.join(userData, 'backend')}：${error.message}。`
      + '请将程序安装或解压到当前用户可写的目录，或通过 YAB_CONFIG_DIR 指定配置位置。', { cause: error });
  }
}

function desktopDataPath(appData, override) {
  if (override) return path.resolve(override);
  // Reuse the whole legacy directory, including settings, runtime and browser state.
  const legacy = path.join(appData, 'baas-desktop');
  return existsSync(legacy) ? legacy : path.join(appData, 'yab-desktop');
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function contained(base, file) {
  if (typeof file !== 'string') return false;
  const rel = path.relative(path.resolve(base), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readActiveRuntime(userData) {
  const state = await readJson(path.join(userData, 'desktop-runtime.json'));
  if (!state || !contained(path.join(userData, 'versions'), state.root || '')
      || !contained(path.join(userData, 'runtimes'), state.python || '')) return null;
  if (!await exists(path.join(state.root, 'server', '__main__.py')) || !await exists(state.python)) return null;
  return state;
}

async function activateRuntime(userData, runtime) {
  await fs.mkdir(userData, { recursive: true });
  const state = path.join(userData, 'desktop-runtime.json');
  if (await exists(state)) await fs.copyFile(state, path.join(userData, `desktop-runtime-${randomUUID()}.json`));
  const pending = path.join(userData, `desktop-runtime-${randomUUID()}.pending`);
  await fs.writeFile(pending, JSON.stringify(runtime, null, 2));
  await fs.rename(pending, state);
}

async function restoreSettings(userData, runtime) {
  if (!runtime.backup || !contained(path.join(userData, 'backups'), runtime.backup)) return;
  for (const { relative, shared } of settingsDirectories(userData, runtime.configRoot)) {
    const source = path.join(runtime.backup, relative);
    if (await exists(source)) await fs.cp(source, shared, { recursive: true, force: true });
  }
}

async function digest(file) {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}

async function verifyBundle(bundle, manifest) {
  if (manifest?.format !== 2 || !/^[a-f0-9]{64}$/.test(manifest.id)
      || !/^[a-f0-9]{64}$/.test(manifest.runtimeKey) || !manifest.files) {
    throw new Error('桌面发行包清单不完整，请重新下载完整包');
  }
  for (const required of ['toolkit/python/python.exe', 'toolkit/uv.exe', 'requirements.txt',
    'app/server/__main__.py', 'app/webapp/dist/index.html', 'app/distribution.json',
    'app/core/ocr/baas_ocr_client/bin/BAAS_ocr_server.exe']) {
    if (!manifest.files[required]) throw new Error(`桌面发行包缺少 ${required}`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!/^(app\/|toolkit\/|wheels\/|requirements\.txt$)/.test(name)
        || name.split('/').some(part => !part || part === '..' || part === '.' || part.startsWith('.'))
        || name.includes('\\') || name.includes(':')
        || /^(app\/config\/|app\/setup\.toml$|app\/core\/ocr\/baas_ocr_client\/bin\/(config|output)\/)/.test(name)
        || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`发行清单路径或校验值不合法：${name}`);
    const file = path.join(bundle, name);
    if ((await fs.lstat(file)).isSymbolicLink() || await digest(file) !== expected) {
      throw new Error(`发行文件校验失败：${name}`);
    }
  }
}

function runProcess(command, args, { cwd, env, signal, output }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      const text = chunk.toString();
      output(text);
      tail.push(text);
      if (tail.length > 20) tail.shift();
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`运行环境准备失败（${code}）：\n${tail.join('')}`)));
  });
}

async function prepareRuntime(bundle, userData, options = {}) {
  const configRoot = options.configRoot ? path.resolve(options.configRoot) : undefined;
  const run = options.run || runProcess;
  const progress = options.progress || (() => {});
  const signal = options.signal;
  const env = { ...process.env, UV_OFFLINE: '1', UV_PYTHON_DOWNLOADS: 'never', UV_NO_CONFIG: '1',
    UV_CACHE_DIR: path.join(userData, 'uv-cache'), UV_LINK_MODE: 'copy',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.VIRTUAL_ENV;
  await fs.mkdir(userData, { recursive: true });
  const log = await fs.open(path.join(userData, 'desktop-setup.log'), 'a');
  const pendingWrites = [];
  const output = text => { pendingWrites.push(log.write(text)); options.output?.(text); };
  const execute = (command, args, cwd = userData) => run(command, args, { cwd, env, signal, output });
  try {
    progress('正在校验内置程序和离线依赖…');
    const manifest = await readJson(path.join(bundle, 'bundle.json'));
    await verifyBundle(bundle, manifest);
    signal?.throwIfAborted();
    const active = await readActiveRuntime(userData);
    const settings = await prepareSettings(userData, configRoot, active?.configRoot);
    if (active?.id === manifest.id && active.runtimeKey === manifest.runtimeKey && active.configRoot === configRoot) {
      try {
        await execute(active.python, PROBE_ARGS);
        return active;
      } catch (error) {
        signal?.throwIfAborted();
        output(`现有环境不可用，重新准备：${error.message}\n`);
      }
    }

    const runtimes = path.join(userData, 'runtimes');
    // Keep native DLL paths below Windows' legacy length limit. Full digests
    // remain in the ready marker; directory names only need a short prefix.
    const runtimePrefix = manifest.runtimeKey.slice(0, 16) + '-';
    await fs.mkdir(runtimes, { recursive: true });
    let runtimeRoot;
    for (const name of await fs.readdir(runtimes)) {
      if (!name.startsWith(runtimePrefix)) continue;
      const directory = path.join(runtimes, name);
      const ready = await readJson(path.join(directory, '.ready.json'));
      if (ready?.path !== directory || ready.key !== manifest.runtimeKey) continue;
      try {
        await execute(path.join(directory, '.venv/Scripts/python.exe'), PROBE_ARGS);
        runtimeRoot = directory;
        break;
      } catch { signal?.throwIfAborted(); }
    }
    if (!runtimeRoot) {
      progress('正在使用内置离线依赖准备运行环境…');
      runtimeRoot = path.join(runtimes, runtimePrefix + randomUUID().slice(0, 12));
      await fs.mkdir(runtimeRoot);
      for (const name of Object.keys(manifest.files).filter(name => name.startsWith('toolkit/'))) {
        const destination = path.join(runtimeRoot, name.slice('toolkit/'.length));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(bundle, name), destination);
      }
      const uv = path.join(runtimeRoot, 'uv.exe');
      const python = path.join(runtimeRoot, '.venv/Scripts/python.exe');
      await execute(uv, ['venv', '--no-config', '--offline', '--no-python-downloads',
        '--python', path.join(runtimeRoot, 'python/python.exe'), path.join(runtimeRoot, '.venv')]);
      await execute(uv, ['pip', 'sync', '--no-config', '--offline', '--no-index', '--no-build', '--require-hashes',
        '--find-links', path.join(bundle, 'wheels'), '--python', python, path.join(bundle, 'requirements.txt')]);
      await execute(uv, ['pip', 'check', '--no-config', '--offline', '--python', python]);
      await execute(python, PROBE_ARGS);
      await fs.writeFile(path.join(runtimeRoot, '.ready.json'), JSON.stringify({ path: runtimeRoot, key: manifest.runtimeKey }));
    }

    progress('正在准备新版程序和配置目录…');
    const root = path.join(userData, 'versions', `${manifest.id.slice(0, 16)}-${randomUUID().slice(0, 12)}`);
    for (const name of Object.keys(manifest.files).filter(name => name.startsWith('app/'))) {
      const destination = path.join(root, name.slice('app/'.length));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(bundle, name), destination);
    }
    // Junctions keep relative-path consumers working with installation-local settings.
    for (const { relative, shared } of settings) {
      await fs.symlink(shared, path.join(root, relative), process.platform === 'win32' ? 'junction' : 'dir');
    }
    signal?.throwIfAborted();
    const backup = path.join(userData, 'backups', randomUUID());
    for (const { relative, shared } of settings) {
      await fs.cp(shared, path.join(backup, relative), { recursive: true });
    }
    return { id: manifest.id, version: manifest.version, runtimeKey: manifest.runtimeKey, backup, configRoot,
      root, python: path.join(runtimeRoot, '.venv/Scripts/python.exe') };
  } finally {
    await Promise.allSettled(pendingWrites);
    await log.close();
  }
}

module.exports = { desktopDataPath, prepareRuntime, activateRuntime, readActiveRuntime, restoreSettings, verifyBundle };

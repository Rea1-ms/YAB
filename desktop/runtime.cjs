'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const { INDEXES, loadRuntimeSettings, resolveUv, runtimeEnvironment } = require('./runtime-settings.cjs');

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
  return path.join(appData, 'yab-desktop');
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

async function verifyBundle(bundle, manifest, progress = () => {}) {
  const online = manifest?.format === 3 && manifest.mode === 'online';
  if ((!online && manifest?.format !== 2) || !/^[a-f0-9]{64}$/.test(manifest.id)
      || !/^[a-f0-9]{64}$/.test(manifest.runtimeKey) || !manifest.files) {
    throw new Error('桌面发行包清单不完整，请重新下载发行包');
  }
  if (online && (!/^3\.11\.\d+$/.test(manifest.python) || !['bundled', 'system'].includes(manifest.uv))) {
    throw new Error('轻量发行包的运行环境配置不完整');
  }
  const tools = online ? ['build-constraints.txt', ...(manifest.uv === 'bundled' ? ['toolkit/uv.exe'] : [])]
    : ['toolkit/python/python.exe', 'toolkit/uv.exe'];
  for (const required of [...tools, 'requirements.txt',
    'app/server/__main__.py', 'app/webapp/dist/index.html', 'app/distribution.json',
    'app/core/ocr/baas_ocr_client/bin/BAAS_ocr_server.exe']) {
    if (!manifest.files[required]) throw new Error(`桌面发行包缺少 ${required}`);
  }
  const files = Object.entries(manifest.files);
  let verified = 0;
  for (const [name, expected] of files) {
    if (!/^(app\/|toolkit\/|wheels\/|requirements\.txt$|build-constraints\.txt$)/.test(name)
        || name.split('/').some(part => !part || part === '..' || part === '.' || part.startsWith('.'))
        || name.includes('\\') || name.includes(':')
        || /^(app\/config\/|app\/setup\.toml$|app\/core\/ocr\/baas_ocr_client\/bin\/(config|output)\/)/.test(name)
        || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`发行清单路径或校验值不合法：${name}`);
    const file = path.join(bundle, name);
    if ((await fs.lstat(file)).isSymbolicLink() || await digest(file) !== expected) {
      throw new Error(`发行文件校验失败：${name}`);
    }
    progress(++verified / files.length);
  }
}

function runProcess(command, args, { cwd, env, signal, output }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', text => {
        output(text);
        tail.push(text);
        if (tail.length > 20) tail.shift();
      });
    }
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`运行环境准备失败（${code}）：\n${tail.join('')}`)));
  });
}

async function prepareRuntime(bundle, userData, options = {}) {
  const configRoot = options.configRoot ? path.resolve(options.configRoot) : undefined;
  const run = options.run || runProcess;
  const progress = options.progress || (() => {});
  const signal = options.signal;
  let env = runtimeEnvironment(false, userData);
  await fs.mkdir(userData, { recursive: true });
  const log = await fs.open(path.join(userData, 'desktop-setup.log'), 'a');
  const pendingWrites = [];
  const output = text => { pendingWrites.push(log.write(text)); options.output?.(text); };
  const execute = (command, args, cwd = userData) => run(command, args, { cwd, env, signal, output });
  try {
    progress('正在校验发行文件…', 2);
    const manifest = await readJson(path.join(bundle, 'bundle.json'));
    await verifyBundle(bundle, manifest, fraction => progress('正在校验发行文件…', 2 + fraction * 16));
    const online = manifest.format === 3;
    env = runtimeEnvironment(online, userData);
    signal?.throwIfAborted();
    const active = await readActiveRuntime(userData);
    progress('正在检查已有运行环境…', 20);
    const settings = await prepareSettings(userData, configRoot, active?.configRoot);
    if (active?.id === manifest.id && active.runtimeKey === manifest.runtimeKey && active.configRoot === configRoot) {
      try {
        await execute(active.python, PROBE_ARGS);
        progress('已有运行环境检查通过，正在复用…', 82);
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
      progress('正在准备运行环境工具…', 24);
      runtimeRoot = path.join(runtimes, runtimePrefix + randomUUID().slice(0, 12));
      await fs.mkdir(runtimeRoot);
      for (const name of Object.keys(manifest.files).filter(name => name.startsWith('toolkit/'))) {
        const destination = path.join(runtimeRoot, name.slice('toolkit/'.length));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(bundle, name), destination);
      }
      const python = path.join(runtimeRoot, '.venv/Scripts/python.exe');
      if (online) {
        const { settings } = await loadRuntimeSettings(configRoot, userData, manifest.uv === 'bundled');
        const uv = await (options.resolveUv || resolveUv)(settings, path.join(runtimeRoot, 'uv.exe'));
        const index = INDEXES[settings.index].url;
        progress('正在检查或准备解释器…', 32);
        await execute(uv, ['python', 'install', '--no-config', '--no-bin', '--no-registry', manifest.python]);
        progress('正在创建独立运行环境…', 46);
        await execute(uv, ['venv', '--no-config', '--managed-python', '--no-python-downloads',
          '--python', manifest.python, path.join(runtimeRoot, '.venv')]);
        progress('正在下载并安装锁定依赖…', 50);
        await execute(uv, ['pip', 'sync', '--no-config', '--require-hashes', '--default-index', index,
          '--build-constraints', path.join(bundle, 'build-constraints.txt'),
          '--python', python, path.join(bundle, 'requirements.txt')]);
        progress('正在校验依赖…', 68);
        await execute(uv, ['pip', 'check', '--no-config', '--python', python]);
      } else {
        const uv = path.join(runtimeRoot, 'uv.exe');
        progress('正在使用内置解释器创建运行环境…', 32);
        await execute(uv, ['venv', '--no-config', '--offline', '--no-python-downloads',
          '--python', path.join(runtimeRoot, 'python/python.exe'), path.join(runtimeRoot, '.venv')]);
        progress('正在安装内置离线依赖…', 50);
        await execute(uv, ['pip', 'sync', '--no-config', '--offline', '--no-index', '--no-build', '--require-hashes',
          '--find-links', path.join(bundle, 'wheels'), '--python', python, path.join(bundle, 'requirements.txt')]);
        progress('正在校验依赖…', 68);
        await execute(uv, ['pip', 'check', '--no-config', '--offline', '--python', python]);
      }
      progress('正在检查运行环境和识别组件…', 72);
      await execute(python, PROBE_ARGS);
      await fs.writeFile(path.join(runtimeRoot, '.ready.json'), JSON.stringify({ path: runtimeRoot, key: manifest.runtimeKey }));
    }

    progress('正在准备新版程序和配置目录…', 74);
    const root = path.join(userData, 'versions', `${manifest.id.slice(0, 16)}-${randomUUID().slice(0, 12)}`);
    const appFiles = Object.keys(manifest.files).filter(name => name.startsWith('app/'));
    let copied = 0;
    for (const name of appFiles) {
      const destination = path.join(root, name.slice('app/'.length));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(bundle, name), destination);
      progress('正在准备新版程序和配置目录…', 74 + ++copied / appFiles.length * 6);
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
    progress('运行环境准备完成…', 82);
    return { id: manifest.id, version: manifest.version, runtimeKey: manifest.runtimeKey, backup, configRoot,
      root, python: path.join(runtimeRoot, '.venv/Scripts/python.exe') };
  } finally {
    await Promise.allSettled(pendingWrites);
    await log.close();
  }
}

module.exports = { desktopDataPath, prepareRuntime, activateRuntime, readActiveRuntime, restoreSettings, verifyBundle };

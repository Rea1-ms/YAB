'use strict';

const fs = require('fs/promises');
const { constants, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync } = require('node:fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { execFileSync, spawn } = require('child_process');
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

async function prepareSettings(userData, configRoot, previousConfigRoot, legacyData = userData) {
  const directories = settingsDirectories(userData, configRoot);
  const previous = settingsDirectories(legacyData, previousConfigRoot);
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

function windowsAccountSid() {
  if (process.platform !== 'win32') return '';
  try {
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    return execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    }).match(/,"(S-1-(?:\d+-)*\d+)"\s*$/i)?.[1] || '';
  } catch {
    return '';
  }
}

function writableDirectory(directory) {
  try {
    mkdirSync(directory, { recursive: true });
    if (!lstatSync(directory).isDirectory()) return false;
    // access(W_OK) on Windows does not check the directory ACL.
    const probe = path.join(directory, '.yab-write-' + randomUUID());
    closeSync(openSync(probe, 'wx'));
    unlinkSync(probe);
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST'].includes(error.code)) return false;
    throw error;
  }
}

function desktopLocations({ installRoot, appData, localAppData, bundled, installed, env = process.env,
  readSid = windowsAccountSid }) {
  const legacyData = desktopDataPath(appData, env.BAAS_DESKTOP_DATA);
  const adjacentConfig = path.join(installRoot, 'config');
  const configOverride = env.YAB_CONFIG_DIR ? path.resolve(env.YAB_CONFIG_DIR) : '';
  if (!bundled) return { userData: legacyData, configRoot: configOverride || adjacentConfig };

  let owner = null;
  if (installed) {
    try { owner = readFileSync(path.join(installRoot, '.yab-data-owner'), 'utf16le').replace(/^\uFEFF/, '').trim(); }
    catch (error) { if (error.code !== 'ENOENT') owner = ''; }
  }
  const adjacentAllowed = owner === null || (/^S-1-(?:\d+-)*\d+$/i.test(owner) && owner === readSid());
  let scope = owner !== null ? 'all-users' : 'current-user';
  if (!installed) scope = 'portable-' + createHash('sha256').update(installRoot.toLowerCase()).digest('hex').slice(0, 12);
  const accountData = path.join(localAppData || appData, 'YAB', scope);
  const adjacentData = path.join(installRoot, 'data');
  const chooseDirectory = (adjacent, name, initializedFile) => {
    const fallback = path.join(accountData, name);
    // Keep using a previously initialized fallback so a permission change
    // does not silently switch the user back to stale settings or runtime data.
    return adjacentAllowed && !existsSync(path.join(fallback, initializedFile)) && writableDirectory(adjacent)
      ? adjacent : fallback;
  };
  const userData = env.BAAS_DESKTOP_DATA ? legacyData : chooseDirectory(adjacentData, 'data', 'desktop-runtime.json');
  const configRoot = configOverride || chooseDirectory(adjacentConfig, 'config', '.desktop-layout.json');
  return { userData, configRoot, adjacentAllowed, adjacentConfig, legacyData };
}

function copyExistingFile(source, destination) {
  if (source === destination || existsSync(destination)) return;
  try {
    if (lstatSync(source).isFile()) copyFileSync(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
  }
}

function migrateDesktopData(locations, bundle) {
  const { userData, configRoot, adjacentAllowed, adjacentConfig, legacyData } = locations;
  if (!legacyData) return {};
  let previous;
  try { previous = JSON.parse(readFileSync(path.join(legacyData, 'desktop-runtime.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const matchesInstall = typeof previous?.root === 'string'
    && previous.root.toLowerCase() === path.join(bundle, 'app').toLowerCase();
  if (userData !== legacyData && matchesInstall) {
    for (const name of ['desktop-settings.json', 'Preferences']) {
      copyExistingFile(path.join(legacyData, name), path.join(userData, name));
    }
    const storage = path.join(legacyData, 'Local Storage');
    const destination = path.join(userData, 'Local Storage');
    if (lstatSync(storage, { throwIfNoEntry: false })?.isDirectory() && !existsSync(destination)) {
      const pending = path.join(userData, '.local-storage-' + randomUUID());
      cpSync(storage, pending, { recursive: true, errorOnExist: true, force: false,
        filter: entry => !lstatSync(entry).isSymbolicLink() && path.basename(entry) !== 'LOCK' });
      renameSync(pending, destination);
    }
  }
  // Only the original account can import installation-local settings.
  let previousConfigRoot = null;
  if (adjacentAllowed && !existsSync(path.join(configRoot, '.desktop-layout.json'))) {
    if (configRoot !== adjacentConfig && lstatSync(adjacentConfig, { throwIfNoEntry: false })?.isDirectory()) {
      previousConfigRoot = adjacentConfig;
    } else if (matchesInstall && typeof previous.configRoot === 'string') {
      previousConfigRoot = previous.configRoot;
    }
  }
  if (previousConfigRoot && previousConfigRoot !== configRoot) {
    mkdirSync(configRoot, { recursive: true });
    for (const name of ['runtime-settings.json', 'webui.json', 'desktop-update.json']) {
      copyExistingFile(path.join(previousConfigRoot, name), path.join(configRoot, name));
    }
  }
  return { previousConfigRoot, legacyData: adjacentAllowed && (!previous || matchesInstall) ? legacyData : userData };
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

async function readRuntime(userData) {
  const state = await readJson(path.join(userData, 'desktop-runtime.json'));
  if (!state || !contained(path.join(userData, 'runtimes'), state.python || '')) return null;
  return state;
}

// Diagnostic/configuration-location record only; never used to select old code.
async function recordRuntime(userData, runtime) {
  await fs.mkdir(userData, { recursive: true });
  const state = path.join(userData, 'desktop-runtime.json');
  if (JSON.stringify(await readJson(state)) === JSON.stringify(runtime)) return;
  const pending = path.join(userData, `desktop-runtime-${randomUUID()}.pending`);
  await fs.writeFile(pending, JSON.stringify(runtime, null, 2));
  await fs.rename(pending, state);
}

async function prepareOcrData(userData, root, configRoot) {
  const key = createHash('sha256').update(root + '\0' + configRoot).digest('hex').slice(0, 16);
  const directory = path.join(userData, 'ocr', key);
  await fs.mkdir(directory, { recursive: true });
  // The native service expects resource/ and config/ under its working directory.
  // Link those directories; binaries and models stay in the installation.
  for (const [name, target] of [
    ['resource', path.join(root, 'core/ocr/baas_ocr_client/bin/resource')],
    ['config', path.join(configRoot, 'ocr')],
  ]) {
    const destination = path.join(directory, name);
    try {
      await fs.symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code !== 'EEXIST' || await fs.realpath(destination) !== await fs.realpath(target)) throw error;
    }
  }
  return directory;
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
  const configRoot = path.resolve(options.configRoot || path.join(userData, 'config'));
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
    const active = await readRuntime(userData);
    progress('正在检查已有运行环境…', 20);
    await prepareSettings(userData, configRoot, active?.configRoot || options.previousConfigRoot, options.legacyData);

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

    progress('正在准备配置和运行数据目录…', 76);
    const root = path.resolve(bundle, 'app');
    const dataRoot = path.join(userData, 'runtime-data');
    await fs.mkdir(dataRoot, { recursive: true });
    const ocrRoot = await prepareOcrData(userData, root, configRoot);
    signal?.throwIfAborted();
    progress('运行环境准备完成…', 82);
    return { id: manifest.id, version: manifest.version, runtimeKey: manifest.runtimeKey, configRoot,
      root, dataRoot, ocrRoot, python: path.join(runtimeRoot, '.venv/Scripts/python.exe') };
  } finally {
    await Promise.allSettled(pendingWrites);
    await log.close();
  }
}

module.exports = { desktopDataPath, desktopLocations, migrateDesktopData, copyExistingFile,
  prepareRuntime, recordRuntime, readRuntime, verifyBundle };

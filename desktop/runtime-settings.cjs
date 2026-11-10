'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);

const INDEXES = Object.freeze({
  pypi: { label: '官方', url: 'https://pypi.org/simple' },
  aliyun: { label: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple' },
  tsinghua: { label: '清华大学', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
});

function validateSettings(value) {
  if (!value || !['bundled', 'system', 'custom'].includes(value.uvMode)
      || !Object.hasOwn(INDEXES, value.index) || typeof value.uvPath !== 'string'
      || (value.uvMode === 'custom' && !path.isAbsolute(value.uvPath))) {
    throw new Error('运行环境设置无效，请重新选择工具位置和下载源');
  }
  return { uvMode: value.uvMode, uvPath: value.uvMode === 'custom' ? value.uvPath : '', index: value.index };
}

function settingsPath(configRoot, userData) {
  return path.join(configRoot || userData, 'runtime-settings.json');
}

async function loadRuntimeSettings(configRoot, userData, bundled = true) {
  try {
    return { configured: true, settings: validateSettings(JSON.parse(await fs.readFile(settingsPath(configRoot, userData), 'utf8'))) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { configured: false, settings: { uvMode: bundled ? 'bundled' : 'system', uvPath: '', index: 'pypi' } };
  }
}

async function saveRuntimeSettings(configRoot, userData, value) {
  const settings = validateSettings(value);
  const file = settingsPath(configRoot, userData);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return settings;
}

async function checkUv(file) {
  if (!path.isAbsolute(file) || !(await fs.stat(file)).isFile()) throw new Error('请选择有效的工具可执行文件');
  const { stdout } = await execute(file, ['--version'], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  const match = /^uv (\d+)\.(\d+)\.(\d+)\b/.exec(stdout.trim());
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 9)) {
    throw new Error('需要 uv（依赖管理工具）0.9.0 或更新版本');
  }
  return { path: file, version: match[0] };
}

async function findSystemUv() {
  const dirs = (process.env.PATH || '').split(path.delimiter).map(dir => dir.replace(/^"|"$/g, ''));
  dirs.push(path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.cargo/bin'));
  const candidates = [...new Set(dirs.filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, process.platform === 'win32' ? 'uv.exe' : 'uv')))];
  for (const file of candidates) {
    try { return await checkUv(file); } catch { /* Continue to the next installed tool. */ }
  }
  throw new Error('未找到可用的系统工具，请选择本地文件或使用内置工具');
}

async function resolveUv(settings, bundledPath) {
  validateSettings(settings);
  if (settings.uvMode === 'system') return (await findSystemUv()).path;
  const file = settings.uvMode === 'bundled' ? bundledPath : settings.uvPath;
  try { return (await checkUv(file)).path; } catch (error) {
    throw new Error(`所选依赖管理工具不可用：${error.message}`);
  }
}

function runtimeEnvironment(online, userData, inherited = process.env) {
  const env = { ...inherited };
  // Host uv policies must not override the selected index, locked hashes or
  // offline guarantee. Preserve the managed interpreter location and transport.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('UV_')) delete env[key];
  }
  for (const key of ['UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_INSTALL_MIRROR', 'UV_HTTP_TIMEOUT', 'UV_SYSTEM_CERTS']) {
    if (online && inherited[key]) env[key] = inherited[key];
  }
  Object.assign(env, { UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1', UV_LINK_MODE: 'copy',
    UV_CACHE_DIR: inherited.UV_CACHE_DIR || path.join(userData, 'uv-cache'),
    UV_PYTHON_DOWNLOADS: online ? 'automatic' : 'never',
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' });
  // The normal uv directory reuses the exact pinned interpreter if present.
  // Keep application dependencies isolated in the dedicated virtual environment.
  if (!online) env.UV_OFFLINE = '1';
  for (const key of ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']) delete env[key];
  return env;
}

module.exports = { INDEXES, validateSettings, loadRuntimeSettings, saveRuntimeSettings, checkUv,
  findSystemUv, resolveUv, runtimeEnvironment };

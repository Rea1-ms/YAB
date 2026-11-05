'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { build, Platform, Arch } = require('electron-builder');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('目前支持在 Windows x64 上构建桌面发行包');
  }
  const root = path.resolve(__dirname, '..');
  const python = process.env.BAAS_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) throw new Error('请先在仓库根准备 Python 3.11 的 .venv 环境');
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const output = path.join(__dirname, 'build', id);
  const release = path.join(__dirname, 'release', id);
  fs.mkdirSync(output, { recursive: true });
  const cache = path.join(__dirname, 'build', 'cache');
  process.env.ELECTRON_BUILDER_CACHE ||= path.join(cache, 'electron-builder');
  process.env.ELECTRON_CACHE ||= path.join(cache, 'electron');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
    PYINSTALLER_CONFIG_DIR: process.env.PYINSTALLER_CONFIG_DIR || path.join(cache, 'pyinstaller') };
  for (const args of [
    ['-B', '-m', 'server.frontend'],
    ['-B', '-m', 'PyInstaller', '--noconfirm', '--distpath', path.join(output, 'dist'),
      '--workpath', path.join(output, 'work'), path.join(__dirname, 'backend.spec')],
  ]) {
    const result = spawnSync(python, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`后端构建失败，退出码 ${result.status}`);
  }
  const backend = path.join(output, 'dist', 'BAAS');
  const version = require('./package.json').version;
  fs.writeFileSync(path.join(backend, 'bundle.json'), JSON.stringify({ id, version }, null, 2));
  process.env.BAAS_BACKEND_DIR = backend;
  process.env.BAAS_RELEASE_DIR = release;
  const config = require('./electron-builder.cjs');
  const targets = Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? ['dir'] : ['nsis'], Arch.x64);
  const artifacts = await build({ targets, config, publish: 'never',
    projectDir: __dirname });
  console.log(`\n桌面产物：${release}`);
  for (const artifact of artifacts) console.log(artifact);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { build, Platform, Arch } = require('electron-builder');
const { prepareInstallerProgress } = require('./installer-progress.cjs');

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('目前支持在 Windows x64 上构建桌面发行包');
  }
  const root = path.resolve(__dirname, '..');
  const python = process.env.BAAS_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) throw new Error('请先在仓库根准备 Python 3.11 的 .venv 环境');
  const uv = process.env.BAAS_UV || 'uv';
  const uvPath = spawnSync(python, ['-c', 'import shutil,sys; print(shutil.which(sys.argv[1]) or sys.argv[1])', uv],
    { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  if (!uvPath || !fs.existsSync(uvPath)) throw new Error('请先安装 uv（环境管理工具），或设置 BAAS_UV 指向其可执行文件');
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const output = path.join(__dirname, 'build', id);
  const release = path.join(__dirname, 'release', id);
  fs.mkdirSync(output, { recursive: true });
  const cache = path.join(__dirname, 'build', 'cache');
  process.env.ELECTRON_BUILDER_CACHE ||= path.join(cache, 'electron-builder');
  process.env.ELECTRON_CACHE ||= path.join(cache, 'electron');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' };
  const backend = path.join(output, 'backend');
  for (const args of [
    ['-B', '-m', 'server.frontend'],
    ['-B', path.join(__dirname, 'bundle.py'), '--output', backend, '--cache', cache, '--uv', uvPath],
  ]) {
    const result = spawnSync(python, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`后端构建失败，退出码 ${result.status}`);
  }
  process.env.BAAS_BACKEND_DIR = backend;
  process.env.BAAS_RELEASE_DIR = release;
  const config = require('./electron-builder.cjs');
  const progressIncludes = prepareInstallerProgress(release);
  const targets = Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? ['dir'] : ['nsis', 'zip'], Arch.x64);
  const artifacts = await build({ targets, config, publish: 'never',
    // Command-line include paths precede the builder's header include paths.
    // Use its normal main script and uninstaller generation/signing pipeline.
    effectiveOptionComputed([, commands]) {
      commands['!addincludedir'] = `"${progressIncludes}"`;
      return false;
    },
    projectDir: __dirname });
  console.log(`\n桌面产物：${release}`);
  for (const artifact of artifacts) console.log(artifact);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

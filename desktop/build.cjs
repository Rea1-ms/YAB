'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { build, Platform, Arch } = require('electron-builder');
const { cache, prepareBuildInput } = require('./build-inputs.cjs');
const { prepareInstallerProgress, installerTemplateRoot } = require('./installer-progress.cjs');
const { updateConfig, installerName, createUpdateManifest } = require('./update-config.cjs');

function publishBuild(stage, release, artifacts, dirOnly) {
  const releaseRoot = path.dirname(release);
  fs.mkdirSync(releaseRoot, { recursive: true });
  if (fs.realpathSync(stage) !== stage || fs.realpathSync(releaseRoot) !== releaseRoot
      || fs.existsSync(release)) {
    throw new Error(`无法发布构建产物：${release}`);
  }
  for (const artifact of artifacts) {
    const entry = fs.lstatSync(artifact);
    const ready = dirOnly ? entry.isDirectory() : entry.isFile() && entry.size > 0;
    if (!ready || path.dirname(artifact) !== stage || fs.realpathSync(artifact) !== artifact) {
      throw new Error(`构建产物不完整或路径异常：${artifact}`);
    }
  }
  // Keep the release unpublished until every output is ready to move together.
  const delivery = fs.mkdtempSync(path.join(stage, 'release-'));
  for (const artifact of artifacts) fs.renameSync(artifact, path.join(delivery, path.basename(artifact)));
  fs.renameSync(delivery, release);

  console.log(`\n桌面产物：${release}`);
  for (const artifact of artifacts) console.log(path.join(release, path.basename(artifact)));
  try {
    if (fs.realpathSync(stage) !== stage) throw new Error('构建临时目录已变化');
    fs.rmSync(stage, { recursive: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`构建产物已保存，临时目录未能清理：${stage}\n${error.message}`);
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('目前支持在 Windows x64 上构建桌面发行包');
  }
  const projectDir = fs.realpathSync(__dirname);
  const root = path.dirname(projectDir);
  const lite = process.argv.includes('--lite');
  const systemUv = process.argv.includes('--system-uv');
  const dirOnly = process.argv.includes('--dir');
  if (systemUv && !lite) throw new Error('系统工具发行模式仅适用于轻量包');
  const variant = lite ? (systemUv ? 'lite-system' : 'lite') : 'offline';
  const python = process.env.BAAS_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) throw new Error('请先在仓库根准备 Python 3.11 的 .venv 环境');
  const uv = process.env.BAAS_UV || 'uv';
  const uvPath = spawnSync(python, ['-c', 'import shutil,sys; print(shutil.which(sys.argv[1]) or sys.argv[1])', uv],
    { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  if (!uvPath || !fs.existsSync(uvPath)) throw new Error('请先安装 uv（环境管理工具），或设置 BAAS_UV 指向其可执行文件');
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '-' + variant;
  const release = path.join(projectDir, 'release', id);
  process.env.ELECTRON_BUILDER_CACHE ||= path.join(cache, 'electron-builder');
  process.env.ELECTRON_CACHE ||= path.join(cache, 'electron');
  const { backend, application } = await prepareBuildInput('backend', ['--uv', uvPath, '--mode', lite ? 'online' : 'offline',
    ...(systemUv ? ['--system-uv'] : [])], python);
  const staging = path.join(projectDir, 'build', 'staging');
  fs.mkdirSync(staging, { recursive: true });
  if (fs.realpathSync(staging) !== staging) throw new Error(`构建临时目录指向其他位置：${staging}`);
  const stage = fs.mkdtempSync(path.join(staging, 'package-'));
  console.log(`构建临时目录：${stage}`);
  process.env.BAAS_BACKEND_DIR = backend;
  process.env.BAAS_APPLICATION_DIR = application;
  process.env.BAAS_RELEASE_DIR = stage;
  process.env.YAB_BUILD_VARIANT = variant;
  // Pass the filename: loading the same cached object twice makes the builder
  // mutate its own publish array while merging configuration.
  const config = path.join(projectDir, 'electron-builder.cjs');
  const progressIncludes = dirOnly ? null : prepareInstallerProgress(stage);
  const targets = Platform.WINDOWS.createTarget(dirOnly ? ['dir'] : ['nsis', 'zip'], Arch.x64);
  await build({ targets, config, publish: 'never',
    // Command-line include paths precede the builder's header include paths.
    // Use its normal main script and uninstaller generation/signing pipeline.
    effectiveOptionComputed([defines, commands]) {
      defines.YAB_REQUIRE_EARLY_THEME = null;
      defines.YAB_INSTALL_COPY_DEBUG = null;
      // NSIS checks its working directory before include paths. The builder's
      // own template directory contains uninstaller.nsh, unlike extraction's
      // nested include. Compile from our generated directory so both win.
      commands['!cd'] = `"${progressIncludes}"`;
      commands['!addincludedir'] = [`"${progressIncludes}"`, `"${installerTemplateRoot()}"`];
      return false;
    },
    projectDir });
  if (dirOnly) {
    publishBuild(stage, release, [path.join(stage, 'win-unpacked')], true);
    return;
  }
  const version = require('./package.json').version;
  const installer = installerName(version, variant);
  const manifest = await createUpdateManifest(stage, updateConfig(variant, process.env.YAB_UPDATE_URL),
    version, process.env.YAB_RELEASE_NOTES || '');
  const artifacts = [installer, installer.replace(/-setup\.exe$/, '.zip'), `${installer}.blockmap`];
  publishBuild(stage, release, [...artifacts.map(name => path.join(stage, name)), manifest], false);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

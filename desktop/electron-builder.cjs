'use strict';

const fs = require('fs');
const path = require('path');

const backend = process.env.BAAS_BACKEND_DIR;
if (!backend || !fs.existsSync(path.join(backend, 'toolkit', 'uv.exe'))
    || !fs.existsSync(path.join(backend, 'app', 'server', '__main__.py'))) {
  throw new Error('请通过 pnpm run dist 或 pnpm run pack 构建完整程序');
}

module.exports = {
  appId: 'org.baas.desktop', // Keep the installation identity so YAB upgrades the existing app.
  productName: 'YAB',
  asar: true,
  // Reuse the platform binary already provided by the local Electron package.
  electronDist: path.dirname(require('electron')),
  directories: { output: process.env.BAAS_RELEASE_DIR },
  files: ['main.js', 'preload.js', 'runtime.cjs', 'assets/**', 'package.json'],
  extraResources: [{ from: backend, to: 'backend' }],
  artifactName: 'YAB-${version}-${arch}.${ext}',
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/installer.ico',
    signExecutable: false,
  },
  nsis: {
    artifactName: 'YAB-${version}-${arch}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    runAfterFinish: false,
    license: '../LICENSE',
  },
};

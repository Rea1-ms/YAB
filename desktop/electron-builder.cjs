'use strict';

const fs = require('fs');
const path = require('path');

const backend = process.env.BAAS_BACKEND_DIR;
if (!backend || !fs.existsSync(path.join(backend, 'BAAS.exe'))) {
  throw new Error('请通过 pnpm run dist 或 pnpm run pack 构建完整程序');
}

module.exports = {
  appId: 'org.baas.desktop',
  productName: 'BAAS',
  asar: true,
  directories: { output: process.env.BAAS_RELEASE_DIR },
  files: ['main.js', 'preload.js', 'runtime.cjs', 'assets/**', 'package.json'],
  extraResources: [{ from: backend, to: 'backend' }],
  artifactName: 'BAAS-${version}-${arch}-setup.${ext}',
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/installer.ico',
    signExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    runAfterFinish: false,
    license: '../LICENSE',
  },
};

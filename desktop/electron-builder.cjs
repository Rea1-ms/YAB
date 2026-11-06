'use strict';

const fs = require('fs');
const path = require('path');

const backend = process.env.BAAS_BACKEND_DIR;
const release = process.env.BAAS_RELEASE_DIR;
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
  afterPack(context) {
    // Remove only files shipped by this build. The installation-local config
    // directory survives upgrades and is removed on uninstall only by choice.
    const entries = fs.readdirSync(context.appOutDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[\w. -]+$/.test(entry.name) || entry.name.toLowerCase() === 'config') {
        throw new Error(`安装文件清单包含非预期路径：${entry.name}`);
      }
    }
    const lines = [fs.readFileSync(path.join(__dirname, 'installer.nsh'), 'utf8'),
      '!macro yabRestoreAndAbort', '  Push ""', '  Call un.restoreFiles', '  Pop $R0',
      '  Abort "Unable to update files. Close YAB and try again."', '!macroend',
      '!macro customRemoveFiles', '  ${if} ${isUpdated}', '    CreateDirectory "$PLUGINSDIR\\old-install"'];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        lines.push(`    CreateDirectory "$PLUGINSDIR\\old-install\\${entry.name}"`,
          `    Push "\\${entry.name}"`, '    Call un.atomicRMDir', '    Pop $R0',
          '    ${if} $R0 != 0', '      !insertmacro yabRestoreAndAbort', '    ${endif}');
      } else {
        lines.push('    ClearErrors', `    IfFileExists "$INSTDIR\\${entry.name}" 0 +2`,
          `    Rename "$INSTDIR\\${entry.name}" "$PLUGINSDIR\\old-install\\${entry.name}"`,
          '    ${if} ${Errors}', '      !insertmacro yabRestoreAndAbort', '    ${endif}');
      }
    }
    lines.push('  ${endif}', '  SetOutPath "$TEMP"');
    for (const entry of entries) {
      lines.push(`  ${entry.isDirectory() ? 'RMDir /r' : 'Delete'} "$INSTDIR\\${entry.name}"`);
    }
    lines.push('  Delete "$INSTDIR\\${UNINSTALL_FILENAME}"', '  RMDir "$INSTDIR"', '  ClearErrors', '!macroend', '');
    fs.mkdirSync(release, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'installer-ui.nsh'), path.join(release, 'installer-ui.nsh'));
    fs.writeFileSync(path.join(release, 'installer-generated.nsh'), lines.join('\r\n'));
  },
  files: ['main.js', 'preload.js', 'runtime.cjs', 'assets/**', 'package.json'],
  extraResources: [{ from: backend, to: 'backend' }],
  artifactName: 'YAB-${version}-${arch}.${ext}',
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/installer.ico',
    signExecutable: false,
  },
  nsis: {
    include: path.join(release, 'installer-generated.nsh'),
    artifactName: 'YAB-${version}-${arch}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    // The custom browser immediately displays the finalized folder.
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    runAfterFinish: false,
    license: '../LICENSE',
  },
};

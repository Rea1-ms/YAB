'use strict';

const fs = require('fs');
const path = require('path');
const { updateConfig } = require('./update-config.cjs');
const updates = updateConfig(process.env.YAB_BUILD_VARIANT || 'offline', process.env.YAB_UPDATE_URL);

// Retry only directories belonging to this build, deepest first. Never walk
// an installed directory at uninstall time or follow directory links.
function packagedDirectories(root, relative = '') {
  const directories = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(relative, entry.name);
    directories.push(...packagedDirectories(root, child), child);
  }
  return directories;
}

const backend = process.env.BAAS_BACKEND_DIR;
const application = process.env.BAAS_APPLICATION_DIR;
const release = process.env.BAAS_RELEASE_DIR;
if (!backend || !fs.existsSync(path.join(backend, 'bundle.json'))
    || !fs.existsSync(path.join(application || path.join(backend, 'app'), 'server', '__main__.py'))) {
  throw new Error('请通过 pnpm run dist 或 pnpm run pack 构建完整程序');
}

module.exports = {
  appId: 'org.baas.desktop', // Keep the installation identity so YAB upgrades the existing app.
  productName: 'YAB',
  extraMetadata: { yabUpdate: updates },
  publish: [{ provider: 'generic', url: updates.url, channel: updates.channel,
    useMultipleRangeRequest: false }],
  asar: true,
  // Reuse the platform binary already provided by the local Electron package.
  electronDist: path.dirname(require('electron')),
  directories: { output: process.env.BAAS_RELEASE_DIR },
  afterPack(context) {
    // Reject a mixed build if source files changed while asar was being written.
    const { createRequire } = require('node:module');
    const builderRequire = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'));
    const asar = builderRequire('@electron/asar');
    const archive = path.join(context.appOutDir, 'resources', 'app.asar');
    if (application && JSON.parse(asar.extractFile(archive, 'package.json')).version
        !== JSON.parse(fs.readFileSync(path.join(backend, 'bundle.json'), 'utf8')).version) {
      throw new Error('桌面与后端版本不一致，请重新构建');
    }
    for (const filename of ['main.js', 'preload.js', 'updater.cjs', 'update-config.cjs']) {
      if (!asar.extractFile(archive, filename).equals(fs.readFileSync(path.join(__dirname, filename)))) {
        throw new Error(`构建期间源文件发生变化，请重新构建：${filename}`);
      }
    }
    if (!asar.extractFile(archive, path.join('node_modules', 'electron-updater', 'out', 'main.js')).length) {
      throw new Error('发行包缺少桌面更新依赖');
    }
    if (context.targets?.every(target => target.name === 'dir')) return;
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
    // The installer writes this icon after packing, outside the application
    // manifest. It belongs to the installation, not the user's retained data.
    lines.push('  !ifdef UNINSTALLER_ICON', '    Delete "$INSTDIR\\uninstallerIcon.ico"', '  !endif',
      '  Delete "$INSTDIR\\${UNINSTALL_FILENAME}"', '  RMDir "$INSTDIR"', '  ClearErrors', '!macroend', '');
    lines.push('!macro yabRemoveEmptyProgramDirectories');
    for (const directory of packagedDirectories(context.appOutDir)) {
      // Escape literal dollar signs rather than interpreting them as variables.
      const target = directory.split(path.sep).join('\\').split('$').join('$$');
      lines.push(`  RMDir "$INSTDIR\\${target}"`);
    }
    lines.push('!macroend', '');
    fs.mkdirSync(release, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'installer-ui.nsh'), path.join(release, 'installer-ui.nsh'));
    fs.copyFileSync(path.join(__dirname, 'installer-pages.nsh'), path.join(release, 'installer-pages.nsh'));
    fs.copyFileSync(path.join(__dirname, 'installer-update-scope.nsh'), path.join(release, 'installer-update-scope.nsh'));
    fs.copyFileSync(path.join(__dirname, 'installer-i18n.nsh'), path.join(release, 'installer-i18n.nsh'));
    fs.cpSync(path.join(__dirname, 'installer-translations'), path.join(release, 'installer-translations'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'installer-controls.nsh'), path.join(release, 'installer-controls.nsh'));
    fs.copyFileSync(path.join(__dirname, 'installer-copy-debug.nsh'), path.join(release, 'installer-copy-debug.nsh'));
    fs.mkdirSync(path.join(release, 'assets'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'assets/YabInstallUI.dll'), path.join(release, 'assets/YabInstallUI.dll'));
    fs.writeFileSync(path.join(release, 'installer-generated.nsh'), lines.join('\r\n'));
  },
  files: ['main.js', 'preload.js', 'runtime.cjs', 'runtime-settings.cjs', 'runtime-window.cjs',
    'runtime-preload.cjs', 'runtime-settings.html', 'runtime-settings-page.js', 'webui.cjs',
    'startup.cjs', 'startup.html', 'startup.css', 'startup-page.js', 'backend-recovery.cjs',
    'window-mode.cjs', 'message-window.cjs', 'message-preload.cjs', 'message.html', 'message-page.js',
    'updater.cjs', 'update-config.cjs', 'assets/**', 'package.json'],
  extraResources: [{ from: backend, to: 'backend' },
    ...(application ? [{ from: application, to: 'backend/app' }] : [])],
  artifactName: 'YAB-${version}-${arch}' + (process.env.YAB_BUILD_VARIANT?.startsWith('lite') ? '-' + process.env.YAB_BUILD_VARIANT : '') + '.${ext}',
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/installer.ico',
    signExecutable: false,
  },
  nsis: {
    include: path.join(release, 'installer-generated.nsh'),
    installerIcon: 'assets/installer.ico',
    uninstallerIcon: 'assets/installer.ico',
    installerSidebar: 'assets/installer-sidebar.bmp',
    uninstallerSidebar: 'assets/installer-sidebar.bmp',
    artifactName: 'YAB-${version}-${arch}' + (process.env.YAB_BUILD_VARIANT?.startsWith('lite') ? '-' + process.env.YAB_BUILD_VARIANT : '') + '-setup.${ext}',
    oneClick: false,
    perMachine: false,
    // The custom browser immediately displays the finalized folder.
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    runAfterFinish: true,
    license: '../LICENSE',
  },
};

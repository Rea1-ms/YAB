'use strict';

const fs = require('fs');
const path = require('path');

// Instrument the installed builder's extraction macros rather than maintaining
// a fork. All copying, retries and error handling remain the upstream code.
function extractionWithProgress(source) {
  const hooks = [
    ['!macro extractEmbeddedAppPackage',
      '  YabInstallUI::Phase /NOUNLOAD "$(yabUnpacking)" 5 15', false],
    ['  !insertmacro compute_files_for_current_arch',
      '  YabInstallUI::Phase /NOUNLOAD "$(yabExtracting)" 15 65', false],
    ['  !insertmacro decompress',
      '  YabInstallUI::Phase /NOUNLOAD "$(yabRegistering)" 90 98', false],
    ['    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
      '    YabInstallUI::Phase /NOUNLOAD "$(yabCopying)" 65 90', true],
    ['    Nsis7z::Extract "${FILE}"',
      '    YabInstallUI::Phase /NOUNLOAD "$(yabExtracting)" 65 90', true],
  ];
  let patched = source.replaceAll('\r\n', '\n');
  for (const [anchor, hook, before] of hooks) {
    if (patched.split(anchor).length !== 2) {
      throw new Error(`安装器模板已变化，需要检查进度阶段：${anchor}`);
    }
    patched = patched.replace(anchor, before ? `${hook}\n${anchor}` : `${anchor}\n${hook}`);
  }
  return patched;
}

function installerTemplateRoot() {
  const builderRoot = path.dirname(require.resolve('app-builder-lib/package.json', {
    paths: [path.dirname(require.resolve('electron-builder'))],
  }));
  return path.join(builderRoot, 'templates/nsis');
}

function prepareInstallerProgress(release) {
  const templateRoot = installerTemplateRoot();
  const source = fs.readFileSync(path.join(templateRoot, 'include/extractAppPackage.nsh'), 'utf8');
  const includeDir = path.join(release, 'nsis-progress');
  fs.mkdirSync(includeDir, { recursive: true });
  // Preserve the upstream working-directory layout. Several builder templates
  // share names with NSIS built-ins (notably multiUser.nsh), so adding an
  // include path alone can select a different implementation.
  fs.cpSync(templateRoot, includeDir, { recursive: true });
  fs.writeFileSync(path.join(includeDir, 'extractAppPackage.nsh'), extractionWithProgress(source));
  const uninstaller = fs.readFileSync(path.join(templateRoot, 'uninstaller.nsh'), 'utf8');
  fs.writeFileSync(path.join(includeDir, 'uninstaller.nsh'), uninstallerWithTheme(uninstaller));
  return includeDir;
}

function uninstallerWithTheme(source) {
  const normalized = source.replaceAll('\r\n', '\n');
  const anchor = 'Function un.onInit\n';
  if (normalized.split(anchor).length !== 2) throw new Error('卸载器模板已变化，需要检查初始化主题');
  // customUnInit runs after process and elevation checks. Initialize the local
  // drawing policy before any of those checks can display a message box.
  return normalized.replace(anchor, anchor + '!define YAB_UNINSTALLER_EARLY_THEME\n  Call un.yabInitTheme\n');
}

module.exports = { extractionWithProgress, prepareInstallerProgress, uninstallerWithTheme, installerTemplateRoot };

'use strict';

const fs = require('fs');
const path = require('path');

// Instrument the installed builder's extraction macros rather than maintaining
// a fork. Keep the builder's copying and retry instructions intact.
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
    ['  LoopExtract7za:', '  !insertmacro yabStartCopyDebug', true],
    ['    ${if} $R1 < 5', '    !insertmacro yabCopyDebugLine "CopyFiles failed (attempt $R1)."', true],
    ['      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION', '      !insertmacro yabInspectCopyFailure', true],
    ['    RMDir /r "$PLUGINSDIR\\7z-out"',
      '    !insertmacro yabCopyDebugLine "Retry selected. Attempting direct extraction."', true],
    ['  AbortExtract7za:', '    !insertmacro yabCopyDebugLine "Cancel selected. Ending installation."', false],
    ['  DoneExtract7za:', '    !insertmacro yabCopyDebugLine "End of program file write stage."', false],
  ];
  let patched = source.replaceAll('\r\n', '\n');
  for (const [anchor, hook, before] of hooks) {
    if (patched.split(anchor).length !== 2) {
      throw new Error(`安装器模板已变化，需要检查扩展位置：${anchor}`);
    }
    patched = patched.replace(anchor, before ? `${hook}\n${anchor}` : `${anchor}\n${hook}`);
  }
  const copyWarning = '"$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za';
  if (patched.split(copyWarning).length !== 2) {
    throw new Error('安装器模板已变化，需要检查写入失败提示');
  }
  return patched.replace(copyWarning, copyWarning.replace('$(appCannotBeClosed)', '$(yabCopyFailed)$yabCopyDebugHint'));
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
  // Node quotes the entire /D argument when an installation path contains
  // spaces. The builder's raw command-line parser otherwise keeps the last quote.
  const multiUser = fs.readFileSync(path.join(templateRoot, 'multiUser.nsh'), 'utf8');
  const readDirectory = '      StrCpy $R9 $R8 "" $R6';
  if (multiUser.split(readDirectory).length !== 2) throw new Error('安装器模板已变化，需要检查目录参数解析');
  const trimQuotes = [
    readDirectory,
    '      StrCpy $R5 $R9 1 -1',
    '      ${If} $R5 == \'"\'',
    '        StrCpy $R9 $R9 -1',
    '      ${EndIf}',
    '      StrCpy $R5 $R9 1',
    '      ${If} $R5 == \'"\'',
    '        StrCpy $R9 $R9 "" 1',
    '      ${EndIf}',
  ].join('\n');
  fs.writeFileSync(path.join(includeDir, 'multiUser.nsh'), multiUser.replace(readDirectory, trimQuotes));
  const section = fs.readFileSync(path.join(templateRoot, 'installSection.nsh'), 'utf8');
  const eol = section.includes('\r\n') ? '\r\n' : '\n';
  const removePrevious = '!insertmacro uninstallOldVersion SHELL_CONTEXT';
  if (section.split(removePrevious).length !== 2) throw new Error('安装器模板已变化，需要检查安装目录权限检查位置');
  const migration = [
    '${if} $installMode == "all"',
    '  !insertmacro uninstallOldVersion HKEY_CURRENT_USER',
    '  !insertmacro handleUninstallResult HKEY_CURRENT_USER',
    '${endIf}',
  ].join(eol);
  if (section.split(migration).length !== 2) throw new Error('安装器模板已变化，需要检查跨范围迁移');
  const scopedMigration = [
    '${if} $installMode == "all"',
    '${andIfNot} ${isUpdated}',
    '  !insertmacro yabCheckPersonalMigration',
    '  ${if} $yabMigratePersonal == 1',
    '    !insertmacro uninstallOldVersion HKEY_CURRENT_USER',
    '    !insertmacro handleUninstallResult HKEY_CURRENT_USER',
    '  ${endIf}',
    '${endIf}',
  ].join(eol);
  fs.writeFileSync(path.join(includeDir, 'installSection.nsh'), section
    .replace(removePrevious, '!insertmacro yabRequireWritableInstallDirectory' + eol + removePrevious)
    .replace(migration, scopedMigration));
  fs.writeFileSync(path.join(includeDir, 'extractAppPackage.nsh'), extractionWithProgress(source));
  const uninstaller = fs.readFileSync(path.join(templateRoot, 'uninstaller.nsh'), 'utf8');
  // The project hook handles both the checkbox and --delete-app-data in the
  // initiating account. The builder would clean more paths as the elevated user.
  const dataStart = '  Var /GLOBAL isDeleteAppData';
  const registryStart = '  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"';
  if (uninstaller.split(dataStart).length !== 2 || uninstaller.split(registryStart).length !== 2
      || uninstaller.indexOf(dataStart) >= uninstaller.indexOf(registryStart)) {
    throw new Error('卸载器模板已变化，需要检查应用数据清理范围');
  }
  const projectDataPolicy = uninstaller.slice(0, uninstaller.indexOf(dataStart)) + uninstaller.slice(uninstaller.indexOf(registryStart));
  fs.writeFileSync(path.join(includeDir, 'uninstaller.nsh'), uninstallerWithTheme(projectDataPolicy));
  const assistedInstaller = fs.readFileSync(path.join(templateRoot, 'assistedInstaller.nsh'), 'utf8');
  fs.writeFileSync(path.join(includeDir, 'assistedInstaller.nsh'), withUninstallNavigation(assistedInstaller));
  return includeDir;
}

function withUninstallNavigation(source) {
  const anchor = '  !insertmacro MUI_UNPAGE_INSTFILES';
  if (source.split(anchor).length !== 2) throw new Error('卸载器模板已变化，需要检查数据确认页');
  // Test registration before command-line scope flags can manufacture a match,
  // and before setInstallModePerAllUsers can prompt for elevation.
  const parameters = '    ${GetParameters} $R0';
  if (source.split(parameters).length !== 2) throw new Error('卸载器模板已变化，需要检查安装登记读取位置');
  return source.replace(anchor, '  !insertmacro yabUninstallDataPage\n' + anchor)
    .replace(parameters, '    !ifdef BUILD_UNINSTALLER\n      !insertmacro yabRequireUninstallRegistration\n    !endif\n' + parameters);
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

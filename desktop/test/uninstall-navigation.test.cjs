'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareInstallerProgress } = require('../installer-progress.cjs');
const newTestDirectory = require('./output.cjs').testDirectories(['navigation.txt']);

test('uninstall confirms the data choice after scope selection and preserves it across Back', {
  skip: process.platform !== 'win32',
}, async t => {
  const cache = path.resolve(__dirname, '../build/cache/electron-builder');
  const [compiler] = await Array.fromAsync(fs.glob('nsis-*/*/makensis.exe', { cwd: cache }));
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await newTestDirectory('uninstall-navigation-');
  const includes = prepareInstallerProgress(scratch);
  const assisted = await fs.readFile(path.join(includes, 'assistedInstaller.nsh'), 'utf8');
  assert.match(assisted, /ReadRegStr \$perUserInstallationFolder HKCU[^]*?!insertmacro yabRequireUninstallRegistration[^]*?\$\{GetOptions\} \$R0 "\/allusers"/);
  const mode = path.join(includes, 'multiUserUi.nsh');
  const messages = [...new Set([...(await fs.readFile(mode, 'utf8')).matchAll(/\$\((\w+)\)/g)].map(m => m[1]))];
  const generator = path.join(scratch, 'generate.exe');
  const uninstaller = path.join(scratch, 'uninstall-preview.exe');
  const source = path.join(scratch, 'navigation.nsi');
  const languages = ['English', 'SimpChinese', 'TradChinese'];
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define BUILD_UNINSTALLER
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
!define UAC_IsInnerInstance '$inner = 1'
!define UAC_IsAdmin '$admin = 1'
!define UAC_SYNCREGISTERS 1
!define isForAllUsers '$forced == "machine"'
!define isForCurrentUser '$forced == "user"'
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${path.resolve(__dirname, '../assets/installer-sidebar.bmp')}"
Var inner
Var admin
Var seen
Var scenario
Var forced
Var dataVisits
Var scopeVisits
Var installMode
Var hasPerMachineInstallation
Var hasPerUserInstallation
Var perMachineInstallationFolder
Var perUserInstallationFolder
Var report
!macro UAC_AsUser_GetGlobalVar OUTPUT
  StrCpy @{OUTPUT} $seen
!macroend
!macro UAC_AsUser_Call type name flags
  FileWriteUTF16LE $report "launching-user=@{name},sync=@{flags}$\r$\n"
  Call @{name}
!macroend
!macro UAC_RunElevated
  FileWriteUTF16LE $report "elevation-requested$\r$\n"
  FileClose $report
  SetErrorLevel 5
  Quit
!macroend
!macro setInstallModePerUser
  StrCpy $installMode "current"
  StrCpy $INSTDIR $perUserInstallationFolder
!macroend
!macro setInstallModePerAllUsers
  StrCpy $installMode "all"
  StrCpy $INSTDIR $perMachineInstallationFolder
!macroend
!macro yabRemoveDataDirectory DIRECTORY
  FileWriteUTF16LE $report "remove=@{DIRECTORY}$\r$\n"
!macroend
!macro yabRemoveEmptyInstallDirectory
  ClearErrors
!macroend
!macro yabUnregisteredUninstallNotice
  FileWriteUTF16LE $report "$(yabUnregisteredUninstall)$\r$\n"
  FileClose $report
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
!include "${mode}"
Name "YAB isolated uninstall navigation"
OutFile "${generator}"
RequestExecutionLevel user
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.inspectWelcome
!insertmacro customUnWelcomePage
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.inspectScope
!insertmacro PAGE_INSTALL_MODE
!insertmacro yabUninstallDataPage
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.inspectFinish
!insertmacro MUI_UNPAGE_FINISH
${languages.map(lang => '!insertmacro MUI_LANGUAGE ' + lang).join('\n')}
${languages.flatMap(lang => messages.map(name => `LangString ${name} @{LANG_${lang.toUpperCase()}} "${name}"`)).join('\n')}
; Drive the real checkbox after the page is ready. No file operations occur.
!macroundef yabStyleCheckbox
!macro yabStyleCheckbox CONTROL PREFIX
  YabInstallUI::Apply /NOUNLOAD $yabDarkMode $yabHighContrast
  Call un.inspectData
!macroend
!insertmacro customHeader
Function un.onInit
  ReadEnvStr $scenario "YAB_PREVIEW_SCOPE"
  ReadEnvStr $forced "YAB_PREVIEW_FORCED_SCOPE"
  ReadEnvStr $inner "YAB_PREVIEW_INNER"
  ReadEnvStr $admin "YAB_PREVIEW_ADMIN"
  ReadEnvStr $seen "YAB_PREVIEW_SEEN"
  ReadEnvStr $LANGUAGE "YAB_PREVIEW_LANGUAGE"
  StrCpy $dataVisits 0
  StrCpy $hasPerUserInstallation 1
  StrCpy $hasPerMachineInstallation 1
  StrCpy $installMode current
  StrCpy $perUserInstallationFolder "$INSTDIR\personal"
  StrCpy $perMachineInstallationFolder "$INSTDIR\machine"
  @{if} $scenario == "machine"
    StrCpy $hasPerUserInstallation 0
    StrCpy $perUserInstallationFolder ""
    StrCpy $installMode all
  @{elseIf} $scenario == "user"
    StrCpy $hasPerMachineInstallation 0
    StrCpy $perMachineInstallationFolder ""
  @{elseIf} $scenario == "none"
    StrCpy $perUserInstallationFolder ""
    StrCpy $perMachineInstallationFolder ""
  @{endif}
  FileOpen $report "$EXEDIR\navigation.txt" w
  !insertmacro yabRequireUninstallRegistration
  !insertmacro customUnInit
FunctionEnd
Function un.inspectWelcome
  FileWriteUTF16LE $report "welcome$\r$\n"
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
FunctionEnd
Function un.inspectScope
  @{NSD_GetState} $MultiUser.InstallModePage.AllUsers $0
  FileWriteUTF16LE $report "scope-all=$0$\r$\n"
  IntOp $scopeVisits $scopeVisits + 1
  @{if} $scopeVisits = 1
    SendMessage $MultiUser.InstallModePage.AllUsers @{BM_CLICK} 0 0
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 3, p 0)'
    Return
  @{endif}
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
FunctionEnd
Function un.inspectData
  @{NSD_GetText} $yabUninstallLocation $0
  StrCmp $0 $INSTDIR +3
    SetErrorLevel 8
    Quit
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'user32::GetWindowTextW(p r0, w.r1, i @{NSIS_MAX_STRLEN})'
  StrCmp $1 "$(^UninstallBtn)" +3
    SetErrorLevel 7
    Quit
  @{NSD_GetState} $yabKeepAppDataCheckbox $0
  FileWriteUTF16LE $report "data=$installMode,$0,$1$\r$\n"
  IntOp $dataVisits $dataVisits + 1
  @{if} $dataVisits = 1
    ; The real click must run after the dialog starts processing notifications.
    System::Call 'user32::PostMessageW(p $yabKeepAppDataCheckbox, i @{BM_CLICK}, p 0, p 0)'
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 3, p 0)'
  @{else}
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
  @{endif}
FunctionEnd
Function un.inspectFinish
  FileWriteUTF16LE $report "finish$\r$\n"
  FileClose $report
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
FunctionEnd
Section
  WriteUninstaller "${uninstaller}"
SectionEnd
Section Uninstall
  GetDlgItem $0 $HWNDPARENT 3
  System::Call 'user32::IsWindowEnabled(p r0)i.r1'
  FileWriteUTF16LE $report "progress-back=$1$\r$\n"
  !insertmacro customUnInstall
SectionEnd
`.replaceAll('@{', '${'));
  const execute = (command, args, env = process.env) =>
    execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
  execute(path.join(cache, compiler), ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
  execute(generator, ['/S']);
  for (const [scope, forced] of [['none', ''], ['user', 'machine'], ['machine', 'user']]) {
    const env = { ...process.env, YAB_PREVIEW_SCOPE: scope, YAB_PREVIEW_FORCED_SCOPE: forced, YAB_PREVIEW_LANGUAGE: '2052' };
    assert.throws(() => execute(uninstaller, [`_?=${scratch}`], env), error => error.status === 2);
    assert.equal((await fs.readFile(path.join(scratch, 'navigation.txt'), 'utf16le')).trim(),
      '在请求的范围内找不到 YAB 的安装记录，无法确定要卸载的目录。');
  }
  assert.throws(() => execute(uninstaller, [`_?=${scratch}`], {
    ...process.env, YAB_PREVIEW_SCOPE: 'machine', YAB_PREVIEW_FORCED_SCOPE: '',
    YAB_PREVIEW_INNER: '0', YAB_PREVIEW_ADMIN: '0', YAB_PREVIEW_LANGUAGE: '2052',
  }), error => error.status === 5);
  assert.deepEqual((await fs.readFile(path.join(scratch, 'navigation.txt'), 'utf16le')).trim().split(/\r?\n/),
    ['welcome', 'elevation-requested']);
  for (const [scope, inner, seen, language, scopePage, welcome] of [
    ['user', '0', '0', '2052', false, true],
    ['machine', '1', '0', '1028', false, true],
    ['both', '0', '0', '1033', true, true],
    ['both', '1', '1', '2052', false, false],
  ]) {
    execute(uninstaller, [`_?=${scratch}`], { ...process.env, YAB_PREVIEW_SCOPE: scope, YAB_PREVIEW_FORCED_SCOPE: '', YAB_PREVIEW_INNER: inner,
      YAB_PREVIEW_SEEN: seen, YAB_PREVIEW_LANGUAGE: language, YAB_PREVIEW_ADMIN: scope === 'user' ? '0' : '1' });
    const events = (await fs.readFile(path.join(scratch, 'navigation.txt'), 'utf16le')).trim().split(/\r?\n/);
    const contents = events.filter(line => line.startsWith('data='));
    assert.equal(contents.length, 2);
    const selected = scope === 'user' ? 'current' : 'all';
    assert.match(contents[0], new RegExp('^data=' + selected + ',1,.+'));
    assert.match(contents[1], new RegExp('^data=' + selected + ',0,.+'));
    assert.deepEqual(events, [
      ...(welcome ? ['welcome'] : []), ...(scopePage ? ['scope-all=0', 'welcome', 'scope-all=1'] : []), contents[0],
      scopePage ? 'scope-all=1' : 'welcome', contents[1], 'progress-back=0',
      ...(inner === '1' ? ['launching-user=un.yabRemoveAccountData,sync=1'] : []),
      ...['config', 'data'].map(name => 'remove=' + path.join(scratch, scope === 'user' ? 'personal' : 'machine', name)),
      'remove=' + path.join(process.env.LOCALAPPDATA, 'YAB', scope === 'user' ? 'current-user' : 'all-users'),
      'remove=' + path.join(process.env.APPDATA, 'yab-desktop'), 'finish',
    ]);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');

async function nsisCompiler() {
  const cache = path.resolve(__dirname, '../build/cache/electron-builder');
  for (const version of await fs.readdir(cache).catch(() => [])) {
    if (!version.startsWith('nsis-') || version.startsWith('nsis-resources-')) continue;
    for (const folder of await fs.readdir(path.join(cache, version))) {
      const executable = path.join(cache, version, folder, 'makensis.exe');
      if (await fs.stat(executable).then(info => info.isFile()).catch(() => false)) return executable;
    }
  }
  return null;
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('compiled uninstall policy preserves data by default and during upgrades', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'uninstall-policy-'));
  const installDir = path.join(scratch, 'test-install');
  for (const mode of [0, 1]) {
    const theme = mode === 0 ? 'dark' : 'light';
    const installer = path.join(scratch, `create-test-uninstaller-${theme}.exe`);
    const uninstaller = path.join(scratch, `test-uninstaller-${theme}.exe`);
    const source = path.join(scratch, `policy-${theme}.nsi`);
    // Compile and execute the real callbacks, replacing only filesystem removal
    // with a log writer. No installation, registry changes or deletion occurs.
    await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!define BUILD_UNINSTALLER
!define APP_FILENAME "YAB"
!macro yabReadThemePreference OUTPUT
  ClearErrors
  StrCpy @{OUTPUT} ${mode}
!macroend
Var installMode
Var testUpdated
Var testLog
!macro _isUpdated _a _b _t _f
  StrCmp $testUpdated "1" "@{_t}" "@{_f}"
!macroend
!define isUpdated '"" isUpdated ""'
!macro yabRemoveDataDirectory DIRECTORY
  FileWrite $testLog "@{DIRECTORY}$\r$\n"
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB uninstall policy test"
OutFile "${installer}"
RequestExecutionLevel user
InstallDir "${installDir}"
!insertmacro customUnWelcomePage
; The builder's multi-user page initializes MUI with an installer prefix even
; when defining an uninstall callback. Exercise that same mismatch here.
!insertmacro MUI_PAGE_INIT
Function un.testMultiUserTheme
  !insertmacro MUI_PAGE_FUNCTION_CUSTOM SHOW
FunctionEnd
UninstPage custom un.testMultiUserTheme
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro customHeader
Function un.onInit
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  StrCpy $installMode "current"
  StrCpy $testUpdated "0"
  @{GetParameters} $R0
  @{GetOptions} $R0 "--updated" $R1
  @{ifNot} @{Errors}
    StrCpy $testUpdated "1"
  @{endif}
  !insertmacro customUnInit
  @{GetParameters} $R0
  @{GetOptions} $R0 "--uncheck" $R1
  @{ifNot} @{Errors}
    StrCpy $yabKeepAppData @{BST_UNCHECKED}
  @{endif}
FunctionEnd
Section
  WriteUninstaller "${uninstaller}"
SectionEnd
Section Uninstall
  FileOpen $testLog "$EXEDIR\result.txt" w
  FileWrite $testLog "state=$yabKeepAppData$\r$\n"
  !insertmacro customUnInstall
  FileClose $testLog
SectionEnd
`.replaceAll('@{', '${'));
    execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
    execute(installer, ['/S']);
    const cases = [
      { name: 'default', args: [], state: 1, remove: false },
      { name: 'unchecked', args: ['--uncheck'], state: 0, remove: true },
      { name: 'explicit silent cleanup', args: ['--delete-app-data'], state: 0, remove: true },
      { name: 'upgrade', args: ['--updated'], state: 1, remove: false },
      { name: 'upgrade after uncheck', args: ['--updated', '--uncheck'], state: 0, remove: false },
    ];
    for (const scenario of cases) {
      execute(uninstaller, ['/S', ...scenario.args, `_?=${installDir}`]);
      const lines = (await fs.readFile(path.join(scratch, 'result.txt'), 'utf8')).trim().split(/\r?\n/);
      assert.equal(lines[0], `state=${scenario.state}`, scenario.name);
      const appData = process.env.APPDATA;
      assert.deepEqual(lines.slice(1), scenario.remove ? [path.join(installDir, 'config'),
        path.join(appData, 'yab-desktop'), path.join(appData, 'baas-desktop')] : [], scenario.name);
    }
    const before = await fs.readFile(path.join(scratch, 'result.txt'), 'utf8');
    for (const args of [['/S', '--updated', '--delete-app-data'], ['--delete-app-data']]) {
      const result = spawnSync(uninstaller, [...args, `_?=${installDir}`], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, 'Reject flags that would bypass upgrade or UI data protection.');
      assert.equal(await fs.readFile(path.join(scratch, 'result.txt'), 'utf8'), before,
        'Rejected uninstall must not run cleanup callbacks.');
    }
  }
  t.diagnostic(`Uninstaller previews (no deletion): ${scratch}`);
});

test('compiled installer previews use an explicit final path without repeated application folders', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const output = path.resolve(__dirname, '../../develop_tools/out');
  const scratch = await fs.mkdtemp(path.join(output, 'installer-preview-'));
  const existing = path.join(scratch, 'existing-custom-folder');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, 'YAB.exe'), 'fixture, not an executable');
  for (const mode of [0, 1]) {
    const executable = path.join(scratch, mode === 0 ? 'preview-dark.exe' : 'preview-light.exe');
    const source = path.join(scratch, `preview-${mode}.nsi`);
    await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
!macro skipPageIfUpdated
!macroend
!macro yabReadThemePreference OUTPUT
  ClearErrors
  StrCpy @{OUTPUT} ${mode}
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB 安装界面预览"
OutFile "${executable}"
RequestExecutionLevel user
InstallDir "${scratch}\preview-target"
!insertmacro MUI_PAGE_LICENSE "${path.resolve(__dirname, '../../LICENSE')}"
; Match electron-builder's multi-user page controls without elevation or
; registry writes, so visual checks cover selected and unselected radio text.
Page custom previewInstallMode
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro MUI_LANGUAGE English
!insertmacro customHeader
Function previewInstallMode
  !insertmacro MUI_HEADER_TEXT "选择安装选项" "应该为谁安装此应用程序？"
  nsDialogs::Create 1018
  Pop $0
  @{NSD_CreateLabel} 0u 0u 300u 20u "选择安装范围："
  Pop $0
  @{NSD_CreateRadioButton} 10u 30u 280u 20u "为使用这台电脑的任何人安装（所有用户）"
  Pop $0
  @{NSD_CreateRadioButton} 10u 50u 280u 20u "仅为我安装（当前用户）"
  Pop $0
  @{NSD_Check} $0
  Call yabApplyTheme
  nsDialogs::Show
FunctionEnd
Function .onInit
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  !insertmacro customInit
  ReadEnvStr $R1 "YAB_PREVIEW_SELECTED"
  @{if} $R1 != ""
    StrCpy $INSTDIR $R1
  @{endif}
FunctionEnd
Section
  ; Preview only: no installation, registry changes or removal.
  ; Silent runs exercise normalization; interactive runs preserve exactly the
  ; directory shown by the real page, including manually entered locations.
  @{if} @{Silent}
    Call yabFinalizeDirectory
    Call yabFinalizeDirectory
  @{endif}
  FileOpen $0 "$EXEDIR\path-result.txt" w
  FileWriteUTF16LE $0 "$INSTDIR"
  FileClose $0
SectionEnd
`.replaceAll('@{', '${'));
    execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
    for (const [selected, expected] of [
      [path.join(scratch, 'parent'), path.join(scratch, 'parent/YAB')],
      [path.join(scratch, 'parent/YAB'), path.join(scratch, 'parent/YAB')],
      [path.join(scratch, 'parent/YAB') + '\\', path.join(scratch, 'parent/YAB')],
      [path.join(scratch, 'parent/yab'), path.join(scratch, 'parent/yab')],
      [path.join(scratch, 'parent/yab-desktop'), path.join(scratch, 'parent/yab-desktop')],
      [path.join(scratch, '测试 path'), path.join(scratch, '测试 path/YAB')],
      [existing, existing],
      [path.parse(scratch).root, path.join(path.parse(scratch).root, 'YAB')],
    ]) {
      execute(executable, ['/S'], { env: { ...process.env, YAB_PREVIEW_SELECTED: selected } });
      assert.equal(await fs.readFile(path.join(scratch, 'path-result.txt'), 'utf16le'), expected, selected);
    }
  }
  t.diagnostic(`Preview executables: ${scratch}`);
});

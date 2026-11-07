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
!define MUI_ICON "${path.resolve(__dirname, '../assets/installer.ico')}"
!define MUI_UNICON "${path.resolve(__dirname, '../assets/installer.ico')}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${path.resolve(__dirname, '../assets/installer-sidebar.bmp')}"
!macro yabReadThemePreference OUTPUT
  ClearErrors
  StrCpy @{OUTPUT} ${mode}
!macroend
Var installMode
Var testUpdated
Var testLog
Var testEmptyBusy
!macro _isUpdated _a _b _t _f
  StrCmp $testUpdated "1" "@{_t}" "@{_f}"
!macroend
!define isUpdated '"" isUpdated ""'
!macro yabRemoveDataDirectory DIRECTORY
  FileWrite $testLog "@{DIRECTORY}$\r$\n"
!macroend
!macro yabRemoveEmptyInstallDirectory
  FileOpen $R9 "$EXEDIR\empty-cleanup.txt" a
  FileSeek $R9 0 END
  FileWrite $R9 "$INSTDIR|$OUTDIR$\r$\n"
  FileClose $R9
  @{if} $testEmptyBusy == "1"
    SetErrors
  @{endif}
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
  ReadEnvStr $testEmptyBusy "YAB_PREVIEW_EMPTY_BUSY"
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
  FileOpen $testLog "$EXEDIR\empty-cleanup.txt" w
  FileClose $testLog
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
      { name: 'nonempty or busy folder', args: [], state: 1, remove: false, busy: true },
    ];
    for (const scenario of cases) {
      execute(uninstaller, ['/S', ...scenario.args, `_?=${installDir}`], {
        env: { ...process.env, YAB_PREVIEW_EMPTY_BUSY: scenario.busy ? '1' : '0' },
      });
      const lines = (await fs.readFile(path.join(scratch, 'result.txt'), 'utf8')).trim().split(/\r?\n/);
      assert.equal(lines[0], `state=${scenario.state}`, scenario.name);
      const appData = process.env.APPDATA;
      assert.deepEqual(lines.slice(1), scenario.remove ? [path.join(installDir, 'config'),
        path.join(appData, 'yab-desktop')] : [], scenario.name);
      const cleanup = (await fs.readFile(path.join(scratch, 'empty-cleanup.txt'), 'utf8')).trim();
      if (scenario.args.includes('--updated')) {
        assert.equal(cleanup, '', 'Updates must leave the installation directory available.');
      } else {
        const attempts = cleanup.split(/\r?\n/);
        assert.equal(attempts.length, scenario.busy ? 3 : 1, 'Empty-directory cleanup has bounded retries.');
        assert.ok(attempts.every(line => line.toLowerCase() === `${installDir}|${process.env.TEMP}`.toLowerCase()),
          'Final cleanup runs outside the installation directory.');
      }
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
!define MUI_ICON "${path.resolve(__dirname, '../assets/installer.ico')}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${path.resolve(__dirname, '../assets/installer-sidebar.bmp')}"
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
!insertmacro customWelcomePage
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

test('real MUI fonts and sidebar rendering work from 100% through 400%', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/installer-dpi-'));
  const executable = path.join(scratch, 'render-check.exe');
  const source = path.join(scratch, 'render-check.nsi');
  const sizes = [[164, 314], [246, 471], [328, 628], [492, 942], [656, 1256]];
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
!macro skipPageIfUpdated
!macroend
!define MUI_WELCOMEFINISHPAGE_BITMAP "${path.resolve(__dirname, '../assets/installer-sidebar.bmp')}"
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB render check"
OutFile "${executable}"
RequestExecutionLevel user
!define MUI_PAGE_CUSTOMFUNCTION_SHOW checkRendering
!insertmacro MUI_PAGE_FINISH
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro MUI_LANGUAGE English
!insertmacro customHeader
Function .onInit
  ReadEnvStr $LANGUAGE "YAB_PREVIEW_LANGUAGE"
  !insertmacro customInit
FunctionEnd
Function checkRendering
  FileOpen $R5 "$EXEDIR\metrics.txt" w
  FileWriteUTF16LE $R5 "language-font=$(^Font)$\r$\n"
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
  FileWriteUTF16LE $R5 "dpi=$0$\r$\n"
  SendMessage $mui.FinishPage.Title @{WM_GETFONT} 0 0 $0
  System::Call 'user32::GetDC(p $mui.FinishPage.Title) p.r1'
  System::Call 'gdi32::SelectObject(p r1, p r0) p.r3'
  System::Call 'gdi32::GetTextFaceW(p r1, i @{NSIS_MAX_STRLEN}, w.r2)'
  FileWriteUTF16LE $R5 "title-font=$2$\r$\n"
  System::Call 'gdi32::SelectObject(p r1, p r3)'
  System::Call 'user32::ReleaseDC(p $mui.FinishPage.Title, p r1)'
  System::Alloc 24
  Pop $R6
  ${sizes.map(([width, height]) => String.raw`
  @{NSD_CreateBitmap} 0 0 ${width} ${height} ""
  Pop $R7
  !insertmacro MUI_INTERNAL_FULLWINDOW_LOADWIZARDIMAGE "" $R7 "$PLUGINSDIR\modern-wizard.bmp" $R8
  System::Call 'gdi32::GetObjectW(p R8, i 24, p R6) i.r0'
  System::Call '*$R6(i, i.r1, i.r2)'
  FileWriteUTF16LE $R5 "bitmap=$0,$1,$2$\r$\n"
  SendMessage $R7 @{STM_SETIMAGE} @{IMAGE_BITMAP} 0
  @{NSD_FreeImage} $R8
  System::Call 'user32::DestroyWindow(p R7)'
`).join('')}
  System::Free $R6
  FileClose $R5
  Quit
FunctionEnd
Section
SectionEnd
`.replaceAll('@{', '${'));
  execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
  for (const language of [2052, 1028, 1033]) {
    const font = 'Microsoft YaHei UI';
    execute(executable, [], { env: { ...process.env, YAB_PREVIEW_LANGUAGE: String(language) } });
    const lines = (await fs.readFile(path.join(scratch, 'metrics.txt'), 'utf16le')).trim().split(/\r?\n/);
    assert.equal(lines[0], `language-font=${font}`);
    assert.match(lines[1], /^dpi=\d+$/);
    assert.equal(lines[2], `title-font=${font}`, 'MUI titles must use the configured outline font.');
    assert.deepEqual(lines.slice(3), sizes.map(([width, height]) => `bitmap=24,${width},${height}`),
      'Render an actual bitmap at each target size, rather than a scaled stock image.');
    t.diagnostic(`${language}: ${lines.slice(0, 3).join(', ')}`);
  }
});

test('native checkbox notifications paint the new glyph and retain click and keyboard state', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/checkbox-render-'));
  for (const mode of [0, 1]) {
    const executable = path.join(scratch, `checkbox-${mode}.exe`);
    const source = path.join(scratch, `checkbox-${mode}.nsi`);
    await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
!macro skipPageIfUpdated
!macroend
!macro yabReadThemePreference OUTPUT
  ClearErrors
  StrCpy @{OUTPUT} ${mode}
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB checkbox rendering test"
OutFile "${executable}"
RequestExecutionLevel user
XPStyle on
Var checkbox
Var tick
Var resultLog
Page custom testPage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro customHeader
!insertmacro yabCheckboxFunctions ""
Function .onInit
  !insertmacro customInit
  StrCpy $yabSidebarBitmap 0
  StrCpy $tick 0
FunctionEnd
Function testPage
  nsDialogs::Create 1018
  Pop $0
  @{NSD_CreateCheckbox} 0 12u 100% 16u "Keep application data"
  Pop $checkbox
  Call yabApplyTheme
  !insertmacro yabStyleCheckbox $checkbox ""
  @{NSD_CreateTimer} testState 100
  nsDialogs::Show
FunctionEnd
Function testState
  IntOp $tick $tick + 1
  @{if} $tick = 1
    FileOpen $resultLog "$EXEDIR\checkbox-${mode}.txt" w
    @{NSD_Check} $checkbox
    System::Call 'user32::RedrawWindow(p $checkbox, p 0, p 0, i 0x185)'
    @{NSD_GetState} $checkbox $0
    FileWrite $resultLog "checked=$0$\r$\n"
    System::Call 'user32::GetDpiForWindow(p $checkbox) i.r0'
    System::Call 'kernel32::MulDiv(i 4, i r0, i 96) i.r1'
    System::Call 'kernel32::MulDiv(i 16, i r0, i 96) i.r2'
    System::Call 'user32::GetClientRect(p $checkbox, @r3)'
    System::Call '*$3(i, i, i.r5, i.r4)'
    System::Call 'user32::GetDC(p $checkbox) p.r0'
    System::Call 'gdi32::CreateCompatibleDC(p r0) p.R0'
    System::Call 'gdi32::CreateCompatibleBitmap(p r0, i r5, i r4) p.R1'
    System::Call 'gdi32::SelectObject(p R0, p R1) p.R2'
    SendMessage $checkbox 0x318 $R0 4 ; WM_PRINTCLIENT, PRF_CLIENT
    IntOp $4 $4 - $2
    IntOp $4 $4 / 2
    IntOp $4 $4 + $1
    System::Call 'gdi32::GetPixel(p R0, i r1, i r4) i.r2'
    FileWrite $resultLog "pixel=$2$\r$\n"
    System::Call 'gdi32::SelectObject(p R0, p R2)'
    System::Call 'gdi32::DeleteObject(p R1)'
    System::Call 'gdi32::DeleteDC(p R0)'
    System::Call 'user32::ReleaseDC(p $checkbox, p r0)'
    SendMessage $checkbox @{BM_CLICK} 0 0
    @{NSD_GetState} $checkbox $0
    FileWrite $resultLog "clicked=$0$\r$\n"
    System::Call 'user32::SetFocus(p $checkbox)'
    SendMessage $checkbox @{WM_KEYDOWN} 32 0
    SendMessage $checkbox @{WM_KEYUP} 32 0
    @{NSD_GetState} $checkbox $0
    FileWrite $resultLog "keyboard=$0$\r$\n"
  @{else}
    FileClose $resultLog
    System::Call 'kernel32::ExitProcess(i 0)'
  @{endif}
FunctionEnd
Section
SectionEnd
`.replaceAll('@{', '${'));
    execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
    execute(executable, []);
    const result = (await fs.readFile(path.join(scratch, `checkbox-${mode}.txt`), 'utf8')).trim().split(/\r?\n/);
    assert.equal(result[0], 'checked=1');
    assert.equal(result[1], `pixel=${mode === 0 ? 0xFFCD60 : 0xD47800}`, 'The real control must use our blue glyph.');
    assert.equal(result[2], 'clicked=0');
    assert.equal(result[3], 'keyboard=1');
  }
});

test('license paragraphs, branding and elevated resume use the real page callbacks', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/license-layout-'));
  const executable = path.join(scratch, 'license-check.exe');
  const source = path.join(scratch, 'license-check.nsi');
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
Var testInner
Var testAccepted
Var report
!define UAC_IsInnerInstance '$testInner = 1'
!macro UAC_AsUser_GetGlobalVar OUTPUT
  StrCpy @{OUTPUT} $testAccepted
!macroend
!macro skipPageIfUpdated
!macroend
!macro yabReadThemePreference OUTPUT
  ClearErrors
  StrCpy @{OUTPUT} 0
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB license layout test"
BrandingText "YAB 1.4.3"
OutFile "${executable}"
RequestExecutionLevel user
!define MUI_PAGE_CUSTOMFUNCTION_SHOW inspectLicense
!insertmacro MUI_PAGE_LICENSE "${path.resolve(__dirname, '../../LICENSE')}"
Page custom afterLicense
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro MUI_LANGUAGE English
!insertmacro customHeader
Function .onInit
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  ReadEnvStr $testInner "YAB_PREVIEW_INNER"
  ReadEnvStr $testAccepted "YAB_PREVIEW_ACCEPTED"
  FileOpen $report "$EXEDIR\layout.txt" w
  !insertmacro customInit
  StrCpy $yabSidebarBitmap 0
FunctionEnd
Function inspectLicense
  Call yabApplyTheme
  System::Alloc 156
  Pop $R0
  System::Call '*$R0(i 156)'
  SendMessage $mui.LicensePage.LicenseText @{EM_SETSEL} 0 0
  SendMessage $mui.LicensePage.LicenseText 0x43D 0 $R0 ; EM_GETPARAFORMAT
  System::Call '*$R0(i, i, i, i, i, i, &i2.r0)'
  FileWriteUTF16LE $report "title=$0$\r$\n"
  SendMessage $mui.LicensePage.LicenseText @{EM_LINEINDEX} 1 0 $0
  SendMessage $mui.LicensePage.LicenseText @{EM_SETSEL} $0 $0
  SendMessage $mui.LicensePage.LicenseText 0x43D 0 $R0
  System::Call '*$R0(i, i, i, i, i, i, &i2.r0)'
  FileWriteUTF16LE $report "version=$0$\r$\n"
  SendMessage $mui.LicensePage.LicenseText @{EM_LINEINDEX} 2 0 $0
  SendMessage $mui.LicensePage.LicenseText @{EM_SETSEL} $0 $0
  SendMessage $mui.LicensePage.LicenseText 0x43D 0 $R0
  System::Call '*$R0(i, i, i, i, i, i, &i2.r0)'
  FileWriteUTF16LE $report "body=$0$\r$\n"
  System::Free $R0
  GetDlgItem $0 $HWNDPARENT 1028
  System::Call 'user32::GetWindowLongW(p r0, i -16) i.r0'
  IntOp $0 $0 & @{WS_VISIBLE}
  FileWriteUTF16LE $report "branding-shadow=$0$\r$\n"
  GetDlgItem $0 $HWNDPARENT 1256
  SendMessage $0 @{WM_GETFONT} 0 0 $R0
  SendMessage $HWNDPARENT @{WM_GETFONT} 0 0 $R1
  IntCmp $R0 $R1 0 +3 +3
  FileWriteUTF16LE $report "branding-font=dialog$\r$\n"
  Goto +2
  FileWriteUTF16LE $report "branding-font=mismatch$\r$\n"
  System::Call 'user32::GetWindowTextW(p $mui.LicensePage.LicenseText, w.r1, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $report "content=$1$\r$\n"
  SendMessage $mui.LicensePage.LicenseText @{EM_SETSEL} 0 0
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
FunctionEnd
Function afterLicense
  FileWriteUTF16LE $report "after-license$\r$\n"
  FileClose $report
  Quit
FunctionEnd
Section
SectionEnd
`.replaceAll('@{', '${'));
  execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
  execute(executable, [], { env: { ...process.env, YAB_PREVIEW_INNER: '0' } });
  const normal = await fs.readFile(path.join(scratch, 'layout.txt'), 'utf16le');
  assert.match(normal, /^title=3\r?\nversion=3\r?\nbody=1\r?\nbranding-shadow=0\r?\nbranding-font=dialog/);
  assert.match(normal, /content=GNU GENERAL PUBLIC LICENSE\r?\nVersion 3, 29 June 2007/);
  assert.match(normal, /Copyright \(C\) 2007 Free Software Foundation, Inc\./);
  assert.match(normal, /after-license/);
  execute(executable, [], { env: { ...process.env, YAB_PREVIEW_INNER: '1', YAB_PREVIEW_ACCEPTED: '1' } });
  assert.equal((await fs.readFile(path.join(scratch, 'layout.txt'), 'utf16le')).trim(), 'after-license',
    'A resumed UAC inner instance must proceed directly, without requesting license acceptance again.');
  execute(executable, [], { env: { ...process.env, YAB_PREVIEW_INNER: '1', YAB_PREVIEW_ACCEPTED: '0' } });
  assert.match(await fs.readFile(path.join(scratch, 'layout.txt'), 'utf16le'), /^title=3\r?\n/,
    'Elevation before acceptance must still display the license.');
});

test('welcome and license pages survive Back navigation after elevated resume', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/installer-navigation-'));
  const executable = path.join(scratch, 'navigation-check.exe');
  const source = path.join(scratch, 'navigation-check.nsi');
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
!define UAC_IsInnerInstance '$testInner = 1'
!define MUI_WELCOMEFINISHPAGE_BITMAP "${path.resolve(__dirname, '../assets/installer-sidebar.bmp')}"
Var testInner
Var testAccepted
Var testBack
Var testBackToWelcome
Var report
!macro UAC_AsUser_GetGlobalVar OUTPUT
  StrCpy @{OUTPUT} $testAccepted
!macroend
!macro skipPageIfUpdated
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB page navigation test"
OutFile "${executable}"
RequestExecutionLevel user
!define MUI_PAGE_CUSTOMFUNCTION_SHOW inspectWelcome
!insertmacro customWelcomePage
!define MUI_PAGE_CUSTOMFUNCTION_SHOW inspectLicense
!insertmacro MUI_PAGE_LICENSE "${path.resolve(__dirname, '../../LICENSE')}"
Page custom afterLicense
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro MUI_LANGUAGE English
!insertmacro customHeader
Function .onInit
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  ReadEnvStr $testInner "YAB_PREVIEW_INNER"
  ReadEnvStr $testAccepted "YAB_PREVIEW_ACCEPTED"
  FileOpen $report "$EXEDIR\navigation.txt" w
  !insertmacro customInit
FunctionEnd
Function inspectWelcome
  FileWrite $report "welcome$\r$\n"
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
FunctionEnd
Function inspectLicense
  FileWrite $report "license$\r$\n"
  @{if} $testBack == "1"
  @{andIf} $testBackToWelcome != "1"
    StrCpy $testBackToWelcome "1"
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 3, p 0)'
  @{else}
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
  @{endif}
FunctionEnd
Function afterLicense
  FileWrite $report "after-license$\r$\n"
  @{if} $testBack == "1"
    FileClose $report
    SetErrorLevel 0
    Quit
  @{endif}
  StrCpy $testBack "1"
  nsDialogs::Create 1018
  Pop $0
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 3, p 0)'
  nsDialogs::Show
FunctionEnd
Section
SectionEnd
`.replaceAll('@{', '${'));
  execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
  for (const [inner, accepted, expected] of [
    ['0', '0', ['welcome', 'license', 'after-license', 'license', 'welcome', 'license', 'after-license']],
    ['1', '1', ['after-license', 'license', 'welcome', 'license', 'after-license']],
    ['1', '0', ['license', 'after-license', 'license', 'welcome', 'license', 'after-license']],
  ]) {
    execute(executable, [], { env: { ...process.env, YAB_PREVIEW_INNER: inner, YAB_PREVIEW_ACCEPTED: accepted } });
    const actual = (await fs.readFile(path.join(scratch, 'navigation.txt'), 'utf8')).trim().split(/\r?\n/);
    assert.deepEqual(actual, expected, `inner=${inner}, accepted=${accepted}`);
  }
});

test('installation status remains visible and updates when the builder suppresses details', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/installer-status-'));
  const executable = path.join(scratch, 'status-check.exe');
  const source = path.join(scratch, 'status-check.nsi');
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define isUpdated '1 = 1'
!macro skipPageIfUpdated
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB live status test"
OutFile "${executable}"
RequestExecutionLevel user
Page custom testProgress
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro MUI_LANGUAGE English
!insertmacro customHeader
Function .onInit
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  !insertmacro customInit
  StrCpy $yabSidebarBitmap 0
FunctionEnd
Function testProgress
  nsDialogs::Create 1018
  Pop $0
  @{NSD_CreateLabel} 0 0 100% 16u ""
  Pop $2
  System::Call 'user32::SetWindowLongW(p r2, i -12, i 1006)'
  @{NSD_CreateProgressBar} 0 20u 100% 16u ""
  Pop $1
  System::Call 'user32::SetWindowLongW(p r1, i -12, i 1004)'
  Call yabApplyTheme
  Call yabStartProgress
  SetDetailsPrint none
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $3 $0 0x7F10
  SendMessage $1 0x406 0 100 ; PBM_SETRANGE32
  FileOpen $4 "$EXEDIR\status.txt" w
  SendMessage $2 @{WM_SETTEXT} 0 "STR:"
  SendMessage $1 0x402 50 0 ; PBM_SETPOS
  System::Call 'user32::GetWindowTextW(p r3, w.r5, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $4 "$5$\r$\n"
  SendMessage $1 0x402 75 0
  System::Call 'user32::GetWindowTextW(p r3, w.r5, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $4 "$5$\r$\n"
  FileClose $4
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
  nsDialogs::Show
FunctionEnd
Section
  ; The actual MUI progress callback must also create its independent label.
  SetDetailsPrint none
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $3 $0 0x7F10
  System::Call 'user32::GetWindowTextW(p r3, w.r5, i @{NSIS_MAX_STRLEN})'
  FileOpen $4 "$EXEDIR\status.txt" a
  FileSeek $4 0 END
  FileWriteUTF16LE $4 "actual-page=$5$\r$\n"
  FileClose $4
  SetErrorLevel 0
  Quit
SectionEnd
`.replaceAll('@{', '${'));
  execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
  execute(executable, []);
  const lines = (await fs.readFile(path.join(scratch, 'status.txt'), 'utf16le')).trim().split(/\r?\n/);
  assert.deepEqual(lines.slice(0, 2), ['正在安装  50%', '正在安装  75%']);
  assert.match(lines[2], /^actual-page=正在安装  \d+%$/);
});

test('uninstall pages keep localized version text and removal status after the shared running check', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/uninstall-status-'));
  const installer = path.join(scratch, 'create-uninstaller.exe');
  const uninstaller = path.join(scratch, 'status-uninstaller.exe');
  const source = path.join(scratch, 'status.nsi');
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define BUILD_UNINSTALLER
!define APP_FILENAME "YAB"
!define VERSION "9.8.7"
!define isUpdated '0 = 1'
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${path.resolve(__dirname, '../assets/installer-sidebar.bmp')}"
; No file removal occurs in this preview, including the success callback.
!macro yabRemoveDataDirectory DIRECTORY
  ClearErrors
!macroend
!macro yabRemoveEmptyInstallDirectory
  ClearErrors
!macroend
Var installMode
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB"
OutFile "${installer}"
RequestExecutionLevel user
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.inspectWelcome
!insertmacro customUnWelcomePage
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro MUI_LANGUAGE TradChinese
!insertmacro MUI_LANGUAGE Japanese
!insertmacro customHeader
; Run the actual shared UI hook without querying or stopping any real process.
!macro IS_POWERSHELL_AVAILABLE
!macroend
!macro _CHECK_APP_RUNNING
!macroend
Function un.onInit
  ReadEnvStr $LANGUAGE "YAB_PREVIEW_LANGUAGE"
  StrCpy $installMode "current"
  !insertmacro customUnInit
FunctionEnd
Function un.inspectWelcome
  FileOpen $R8 "$EXEDIR\welcome.txt" w
  System::Call 'user32::GetWindowTextW(p $mui.WelcomePage.Title, w.r1, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $R8 "$1$\r$\n"
  System::Call 'user32::GetWindowTextW(p $mui.WelcomePage.Text, w.r1, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $R8 "$1$\r$\n"
  FileClose $R8
  ; Continue through the welcome and data pages to the real uninstall section.
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
FunctionEnd
Section
  WriteUninstaller "${uninstaller}"
SectionEnd
Section Uninstall
  SetDetailsPrint none
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $3 $0 0x7F10
  System::Call 'user32::GetWindowTextW(p r3, w.r5, i @{NSIS_MAX_STRLEN})'
  FileOpen $4 "$EXEDIR\status.txt" w
  FileWriteUTF16LE $4 "$5$\r$\n"
  !insertmacro customCheckAppRunning
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1004
  GetDlgItem $3 $0 0x7F10
  SendMessage $1 0x406 0 100
  SendMessage $1 0x402 75 0
  System::Call 'user32::GetWindowTextW(p r3, w.r5, i @{NSIS_MAX_STRLEN})'
  FileWriteUTF16LE $4 "$5$\r$\n"
  FileClose $4
  !insertmacro customUnInstall
  SetErrorLevel 0
  Quit
SectionEnd
`.replaceAll('@{', '${'));
  execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
  execute(installer, ['/S']);
  for (const [language, title, status] of [
    [2052, '欢迎使用 YAB v9.8.7 解除安装向导', '删除文件'],
    [1028, '歡迎使用 YAB v9.8.7 解除安裝程式', '移除檔案'],
    [1033, 'Welcome to YAB v9.8.7 Uninstall', 'Remove files'],
    [1041, 'Welcome to YAB v9.8.7 Uninstall', 'Remove files'],
  ]) {
    execute(uninstaller, [`_?=${scratch}`], {
      env: { ...process.env, YAB_PREVIEW_LANGUAGE: String(language) },
    });
    const welcome = await fs.readFile(path.join(scratch, 'welcome.txt'), 'utf16le');
    assert.equal(welcome.split(/\r?\n/)[0], title);
    if (language === 2052) {
      assert.match(welcome, /这个向导将全程指引你 YAB 的解除安装进程。/,
        'Keep the standard MUI wording instead of adding our own welcome copy.');
    }
    const lines = (await fs.readFile(path.join(scratch, 'status.txt'), 'utf16le')).trim().split(/\r?\n/);
    assert.ok(lines[0].startsWith(`${status}  `), 'The real uninstall page must start in the removal stage.');
    assert.ok(lines[1].startsWith(`${status}  `) && /\d+%$/.test(lines[1]),
      'The shared process check must not switch back to installation.');
  }
});

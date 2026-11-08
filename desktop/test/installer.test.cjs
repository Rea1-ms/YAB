'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractionWithProgress, prepareInstallerProgress } = require('../installer-progress.cjs');

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

test('generated uninstall cleanup includes the installer icon outside the application manifest', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/uninstall-files-'));
  const backend = path.join(scratch, 'backend');
  const appOutDir = path.join(scratch, 'application');
  const release = path.join(scratch, 'release');
  const installDir = path.join(scratch, 'test-install');
  await fs.mkdir(path.join(backend, 'toolkit'), { recursive: true });
  await fs.mkdir(path.join(backend, 'app/server'), { recursive: true });
  await fs.mkdir(path.join(appOutDir, 'resources'), { recursive: true });
  await fs.writeFile(path.join(backend, 'toolkit/uv.exe'), 'fixture, not an executable');
  await fs.writeFile(path.join(backend, 'app/server/__main__.py'), '# fixture\n');
  await fs.writeFile(path.join(appOutDir, 'YAB.exe'), 'fixture, not an executable');
  execute(process.execPath, ['-e', 'require(process.argv[1]).afterPack({ appOutDir: process.argv[2] });',
    path.resolve(__dirname, '../electron-builder.cjs'), appOutDir], {
    env: { ...process.env, BAAS_BACKEND_DIR: backend, BAAS_RELEASE_DIR: release },
  });
  const generated = await fs.readFile(path.join(release, 'installer-generated.nsh'), 'utf8');
  // Execute the actual generated cleanup macro with deletion replaced by logs.
  // The upgrade branch is inactive, so no file is moved or removed.
  const cleanup = generated.slice(generated.indexOf('!macro yabRestoreAndAbort'))
    .replace(/^(\s*)(Delete|RMDir(?: \/r)?) "([^"]+)"\r?$/gm,
      (_, indent, operation, target) => `${indent}FileWrite $testLog "${operation}|${target}$\\r$\\n"`);
  for (const withIcon of [true, false]) {
    const name = withIcon ? 'with-icon' : 'without-icon';
    const installer = path.join(scratch, `create-${name}.exe`);
    const uninstaller = path.join(scratch, `uninstall-${name}.exe`);
    const source = path.join(scratch, `${name}.nsi`);
    await fs.writeFile(source, String.raw`
Unicode true
!include LogicLib.nsh
!define isUpdated '0 = 1'
!define UNINSTALL_FILENAME "Uninstall YAB.exe"
${withIcon ? '!define UNINSTALLER_ICON "fixture.ico"' : ''}
Var testLog
${cleanup}
Name "YAB generated uninstall cleanup test"
OutFile "${installer}"
RequestExecutionLevel user
InstallDir "${installDir}"
Function un.atomicRMDir
  Pop $R0
  Push 0
FunctionEnd
Function un.restoreFiles
  Pop $R0
  Push 0
FunctionEnd
Section
  WriteUninstaller "${uninstaller}"
SectionEnd
Section Uninstall
  FileOpen $testLog "$EXEDIR\files-${name}.txt" w
  !insertmacro customRemoveFiles
  FileClose $testLog
SectionEnd
`);
    execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
    execute(installer, ['/S']);
    execute(uninstaller, ['/S', `_?=${installDir}`]);
    const lines = (await fs.readFile(path.join(scratch, `files-${name}.txt`), 'utf8')).trim().split(/\r?\n/);
    assert.equal(lines.at(-1), `RMDir|${installDir}`, 'Remove the root nonrecursively after its contents.');
    assert.deepEqual(lines.sort(), [
      `Delete|${path.join(installDir, 'YAB.exe')}`,
      `RMDir /r|${path.join(installDir, 'resources')}`,
      ...(withIcon ? [`Delete|${path.join(installDir, 'uninstallerIcon.ico')}`] : []),
      `Delete|${path.join(installDir, 'Uninstall YAB.exe')}`,
      `RMDir|${installDir}`,
    ].sort(), 'Only packaged files and installer-owned files are removed.');
  }
  t.diagnostic(`Generated uninstall cleanup previews (no deletion): ${scratch}`);
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
!macro testCheckboxPixel NAME POINT
  System::Call 'user32::RedrawWindow(p $checkbox, p 0, p 0, i 0x185)'
  System::Call 'user32::GetDpiForWindow(p $checkbox) i.r0'
  System::Call 'kernel32::MulDiv(i @{POINT}, i r0, i 96) i.r1'
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
  FileWrite $resultLog "@{NAME}=$2$\r$\n"
  System::Call 'gdi32::SelectObject(p R0, p R2)'
  System::Call 'gdi32::DeleteObject(p R1)'
  System::Call 'gdi32::DeleteDC(p R0)'
  System::Call 'user32::ReleaseDC(p $checkbox, p r0)'
!macroend
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
    !insertmacro testCheckboxPixel pixel 4
    SendMessage $checkbox @{BM_SETSTATE} 1 0
    !insertmacro testCheckboxPixel pressed 4
    SendMessage $checkbox @{BM_SETSTATE} 0 0
    EnableWindow $checkbox 0
    !insertmacro testCheckboxPixel disabled 4
    EnableWindow $checkbox 1
    SendMessage $checkbox @{BM_CLICK} 0 0
    @{NSD_GetState} $checkbox $0
    FileWrite $resultLog "clicked=$0$\r$\n"
    !insertmacro testCheckboxPixel unchecked 4
    System::Call 'user32::GetSysColor(i 15) i.r0'
    FileWrite $resultLog "system-background=$0$\r$\n"
    System::Call 'user32::SetFocus(p $checkbox)'
    SendMessage $checkbox @{WM_KEYDOWN} 32 0
    SendMessage $checkbox @{WM_KEYUP} 32 0
    @{NSD_GetState} $checkbox $0
    FileWrite $resultLog "keyboard=$0$\r$\n"
    SendMessage $checkbox @{BM_SETSTYLE} 6 1 ; BS_AUTO3STATE
    SendMessage $checkbox @{BM_SETCHECK} 2 0
    @{NSD_GetState} $checkbox $0
    FileWrite $resultLog "indeterminate=$0$\r$\n"
    !insertmacro testCheckboxPixel indeterminate-pixel 8
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
    const readings = Object.fromEntries(result.map(line => line.split('=').map((value, i) => i ? Number(value) : value)));
    const accent = mode === 0 ? 0xFFCD60 : 0xD47800;
    assert.equal(readings.checked, 1);
    assert.equal(readings.pixel, accent, 'The real control must use the blue Microsoft glyph.');
    assert.equal(readings.pressed, mode === 0 ? 0xD7AA48 : 0x9E5600);
    assert.equal(readings.disabled, mode === 0 ? 0x646464 : 0xA0A0A0);
    assert.equal(readings.clicked, 0);
    assert.equal(readings.unchecked, mode === 0 ? 0x202020 : readings['system-background'],
      'The unchecked glyph must leave its interior transparent.');
    assert.equal(readings.keyboard, 1);
    assert.equal(readings.indeterminate, 2);
    assert.equal(readings['indeterminate-pixel'], accent, 'The half-selected state must use its own glyph.');
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
  GetDlgItem $6 $0 0x7F11
  FileOpen $4 "$EXEDIR\status.txt" w
  SendMessage $2 @{WM_SETTEXT} 0 "STR:"
  !macro recordProgress
    System::Call 'user32::GetWindowTextW(p r3, w.r5, i @{NSIS_MAX_STRLEN})'
    SendMessage $6 0x408 0 0 $7 ; PBM_GETPOS: visible total
    SendMessage $1 0x408 0 0 $8 ; raw control remains owned by NSIS/plugins
    FileWriteUTF16LE $4 "$5|$7|$8$\r$\n"
  !macroend
  YabInstallUI::Phase /NOUNLOAD "$(yabUnpacking)" 5 15
  SendMessage $1 0x406 0 1000 ; PBM_SETRANGE32
  SendMessage $1 0x402 500 0 ; PBM_SETPOS
  !insertmacro recordProgress
  SendMessage $1 0x402 1000 0
  !insertmacro recordProgress
  SendMessage $1 0x402 690 0 ; reported 100% -> 69% handoff
  !insertmacro recordProgress
  YabInstallUI::Phase /NOUNLOAD "$(yabExtracting)" 15 65
  SendMessage $1 0x406 0 100
  !insertmacro recordProgress ; changing ranges must not sample stale positions
  SendMessage $1 0x402 0 0
  !insertmacro recordProgress
  SendMessage $1 0x402 50 0 ; PBM_SETPOS
  !insertmacro recordProgress
  SendMessage $1 0x402 100 0
  !insertmacro recordProgress
  SendMessage $1 0x406 0 1000
  SendMessage $1 0x402 690 0 ; restore the installer instruction counter
  !insertmacro recordProgress
  YabInstallUI::Phase /NOUNLOAD "$(yabCopying)" 65 90
  SendMessage $1 0x402 500 0
  !insertmacro recordProgress
  SendMessage $1 0x402 1000 0
  !insertmacro recordProgress
  YabInstallUI::Phase /NOUNLOAD "$(yabCopying)" 65 90 ; copy retry
  SendMessage $1 0x402 10 0
  !insertmacro recordProgress
  YabInstallUI::Phase /NOUNLOAD "$(yabRegistering)" 90 98
  SendMessage $1 0x406 0 100
  SendMessage $1 0x402 50 0
  !insertmacro recordProgress
  SendMessage $1 0x403 25 0 ; PBM_DELTAPOS
  !insertmacro recordProgress
  SendMessage $1 0x404 25 0 ; PBM_SETSTEP
  SendMessage $1 0x405 0 0 ; PBM_STEPIT
  !insertmacro recordProgress
  !insertmacro customInstall
  SendMessage $1 0x402 100 0
  !insertmacro recordProgress ; raw 100 must never imply successful completion
  Call .onInstSuccess
  !insertmacro recordProgress
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
  const readings = lines.slice(0, -1).map(line => {
    const [text, visible, raw] = line.split('|');
    return { text, visible: Number(visible), raw: Number(raw) };
  });
  assert.deepEqual(readings.map(row => row.visible),
    [10, 15, 15, 15, 15, 40, 65, 65, 77, 90, 90, 94, 96, 98, 99, 100]);
  assert.deepEqual(readings.slice(0, 3).map(row => row.raw), [500, 1000, 690],
    'Do not rewrite the raw counter that NSIS and the extraction plugin still use.');
  for (const row of readings) assert.ok(row.text.endsWith(`  ${row.visible}%`), row.text);
  assert.ok(readings[5].text.startsWith('正在解压程序文件'));
  assert.ok(readings[8].text.startsWith('正在写入程序文件'));
  assert.equal(readings.at(-1).text, '安装完成  100%');
  assert.match(lines.at(-1), /^actual-page=正在准备安装…  [0-5]%$/,
    'A newly created real progress page must reset the total and retain its independent label.');
});

test('the packaged extraction template keeps builder retries and drives the real staged progress', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const cache = path.resolve(__dirname, '../build/cache/electron-builder');
  const sevenZipRoot = path.join(cache, '7zip@1.0.0');
  const sevenZipFolder = (await fs.readdir(sevenZipRoot)).find(name => /^7zip-win-x64-/.test(name) && !name.endsWith('.state'));
  const sevenZip = path.join(sevenZipRoot, sevenZipFolder, 'bin/7za.exe');
  const resourceRoot = path.join(cache, 'nsis-resources-3.4.1');
  const resourceFolder = (await fs.readdir(resourceRoot)).find(name => name.startsWith('nsis-resources-3.4.1-') && !name.endsWith('.state'));
  const plugins = path.join(resourceRoot, resourceFolder, 'plugins/x86-unicode');
  const builderRoot = path.dirname(require.resolve('app-builder-lib/package.json', {
    paths: [path.dirname(require.resolve('electron-builder'))],
  }));
  const templateDir = path.join(builderRoot, 'templates/nsis/include');
  const original = (await fs.readFile(path.join(templateDir, 'extractAppPackage.nsh'), 'utf8')).replaceAll('\r\n', '\n');
  const patched = extractionWithProgress(original);
  assert.equal(patched.replace(/^ +YabInstallUI::Phase[^\n]*\n/gm, ''), original,
    'Retain all upstream file-copy, retry and cancellation instructions unchanged.');
  assert.throws(() => extractionWithProgress(original.replace('!insertmacro decompress', '!insertmacro new_decompress')),
    /安装器模板已变化/, 'A builder upgrade must not silently omit progress stages.');

  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/installer-extraction-'));
  const includeDir = prepareInstallerProgress(scratch);
  const payload = path.join(scratch, 'payload.txt');
  const archive = path.join(scratch, 'payload.7z');
  await fs.writeFile(payload, 'YAB isolated extraction check\n');
  execute(sevenZip, ['a', '-t7z', archive, payload]);
  const source = path.join(scratch, 'extraction.nsi');
  const executable = path.join(scratch, 'extraction.exe');
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define APP_64 "${archive}"
!define COMPRESSION_METHOD "7z"
!define RunningX64 '1 = 1'
!define IsNativeARM64 '0 = 1'
!define isUpdated '1 = 1'
!macro skipPageIfUpdated
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
!addincludedir "${templateDir}"
!addplugindir /x86-unicode "${plugins}"
; The same command-line include precedence is used by the official build.
!include extractAppPackage.nsh
Name "YAB extraction test"
OutFile "${executable}"
RequestExecutionLevel user
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE SimpChinese
LangString appCannotBeClosed @{LANG_SIMPCHINESE} "Copy failed"
!insertmacro customHeader
Function .onInit
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  StrCpy $yabSidebarBitmap 0
  !insertmacro customInit
FunctionEnd
Section
  InitPluginsDir
  SetOutPath "$EXEDIR\target"
  SetDetailsPrint none
  !insertmacro extractEmbeddedAppPackage
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 0x7F10
  GetDlgItem $2 $0 0x7F11
  System::Call 'user32::GetWindowTextW(p r1, w.r3, i @{NSIS_MAX_STRLEN})'
  SendMessage $2 0x408 0 0 $5
  FileOpen $4 "$EXEDIR\extraction.txt" w
  FileWriteUTF16LE $4 "$3|$5"
  FileClose $4
  SetErrorLevel 0
  Quit
SectionEnd
`.replaceAll('@{', '${'));
  execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', `/X!addincludedir "${includeDir}"`, source]);
  execute(executable, []);
  assert.equal(await fs.readFile(path.join(scratch, 'target/payload.txt'), 'utf8'), await fs.readFile(payload, 'utf8'));
  const [label, total] = (await fs.readFile(path.join(scratch, 'extraction.txt'), 'utf16le')).split('|');
  assert.ok(Number(total) >= 90 && Number(total) <= 98, label);
  assert.equal(label, `正在保存安装信息…  ${total}%`);
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

test('native cancel confirmation keeps its result and follows the wizard theme', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/cancel-dialog-'));
  for (const theme of [0, 1]) {
    const source = path.join(scratch, `cancel-${theme}.nsi`);
    const executable = path.join(scratch, `cancel-${theme}.exe`);
    await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
!define MUI_CUSTOMFUNCTION_ABORT recordExit
!macro yabReadThemePreference OUTPUT
  ClearErrors
  StrCpy @{OUTPUT} ${theme}
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
Name "YAB cancel test"
OutFile "${executable}"
RequestExecutionLevel user
XPStyle on
Var phase
Var report
Var description
Page custom testPage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE SimpChinese
!insertmacro customHeader
Function .onInit
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  StrCpy $phase 0
  !insertmacro customInit
  StrCpy $yabSidebarBitmap 0
  FileOpen $report "$EXEDIR\result-${theme}.txt" w
FunctionEnd
Function testPage
  nsDialogs::Create 1018
  Pop $0
  @{NSD_CreateLabel} 0 0 100% 20u "Keep this page"
  Pop $description
  Call yabApplyTheme
  @{NSD_CreateTimer} inspectModal 100
  nsDialogs::Show
FunctionEnd
Function inspectModal
  System::Call 'user32::GetLastActivePopup(p $HWNDPARENT) p.r0'
  @{if} $0 == $HWNDPARENT
    @{if} $phase == 0
      StrCpy $phase 1
      ; Exercise the real Cancel callback and the real native MessageBox.
      System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 2, p 0)'
    @{elseIf} $phase == 2
      System::Call 'user32::IsWindowEnabled(p $HWNDPARENT) i.r1'
      FileWriteUTF16LE $report "resumed=$1$\r$\n"
      System::Call 'user32::GetWindowTextW(p $description, w.r1, i @{NSIS_MAX_STRLEN})'
      FileWriteUTF16LE $report "page=$1$\r$\n"
      StrCpy $phase 3
      ; The title-bar close button must use the same confirmation.
      System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_CLOSE}, p 0, p 0)'
    @{endif}
    Return
  @{endif}
  GetDlgItem $1 $0 6
  GetDlgItem $2 $0 7
  @{if} $1 P= 0
  @{orIf} $2 P= 0
    Return
  @{endif}
  @{if} $phase == 1
    System::Call 'user32::GetPropW(p r0, w "YAB.MessageBox") p.r3'
    FileWriteUTF16LE $report "themed=$3$\r$\n"
    GetDlgItem $3 $0 65535
    System::Call 'user32::GetWindowTextW(p r3, w.r4, i @{NSIS_MAX_STRLEN})'
    FileWriteUTF16LE $report "prompt=$4$\r$\n"
    System::Call 'user32::GetClientRect(p r0, @r3)'
    System::Call '*$3(i, i, i, i.r4)'
    System::Call 'user32::GetDC(p r0) p.r5'
    System::Call 'gdi32::GetPixel(p r5, i 5, i 5) i.r6'
    FileWriteUTF16LE $report "body=$6$\r$\n"
    IntOp $4 $4 - 5
    System::Call 'gdi32::GetPixel(p r5, i 5, i r4) i.r6'
    FileWriteUTF16LE $report "footer=$6$\r$\n"
    System::Call 'user32::ReleaseDC(p r0, p r5)'
    System::Call 'user32::GetDC(p r1) p.r5'
    System::Call 'gdi32::GetPixel(p r5, i 8, i 7) i.r6'
    FileWriteUTF16LE $report "button=$6$\r$\n"
    System::Call 'user32::ReleaseDC(p r1, p r5)'
    StrCpy $phase 2
    System::Call 'user32::PostMessageW(p r0, i @{WM_COMMAND}, p 7, p r2)'
  @{elseIf} $phase == 3
    FileWriteUTF16LE $report "close-prompt=1$\r$\n"
    @{NSD_KillTimer} inspectModal
    System::Call 'user32::PostMessageW(p r0, i @{WM_COMMAND}, p 6, p r1)'
  @{endif}
FunctionEnd
Function recordExit
  FileWriteUTF16LE $report "exit=1$\r$\n"
  FileClose $report
FunctionEnd
Section
  ; Reaching installation would be a test failure; no files are installed.
  SetErrorLevel 17
SectionEnd
`.replaceAll('@{', '${'));
    execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
    const run = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.ifError(run.error);
    assert.equal(run.status, 1, 'Yes exits with the native user-cancel result.');
    const report = await fs.readFile(path.join(scratch, `result-${theme}.txt`), 'utf16le');
    assert.match(report, new RegExp(`themed=${theme === 0 ? 1 : 0}\\r?\\n`));
    assert.match(report, /prompt=你确实要退出 YAB cancel test 安装程序吗？/);
    assert.match(report, /resumed=1\r?\npage=Keep this page/);
    assert.match(report, /close-prompt=1\r?\nexit=1/);
    const body = Number(report.match(/body=(\d+)/)[1]);
    const footer = Number(report.match(/footer=(\d+)/)[1]);
    if (theme === 0) {
      assert.equal(body, 0x202020, 'The actual native dialog body uses the dark canvas.');
      assert.equal(footer, 0x202020, 'The native button footer must also be dark.');
      assert.match(report, new RegExp(`button=${0xFFCD60}\\r?\\n`), 'Reuse the wizard button renderer.');
    } else {
      assert.notEqual(body, 0x202020, 'Keep the standard light dialog appearance.');
    }
    t.diagnostic(`theme=${theme}: body=${body}, footer=${footer}`);
  }
});

test('real install-mode navigation clears elevation shields and paints the icon with its caption', {
  skip: process.platform !== 'win32',
}, async t => {
  const compiler = await nsisCompiler();
  if (!compiler) return t.skip('Build the desktop installer once to populate the NSIS cache.');
  const builder = path.dirname(require.resolve('app-builder-lib/package.json', {
    paths: [path.dirname(require.resolve('electron-builder/package.json'))],
  }));
  const modePage = path.join(builder, 'templates/nsis/multiUserUi.nsh');
  const messages = [...new Set([...((await fs.readFile(modePage, 'utf8')).matchAll(/\$\((\w+)\)/g))]
    .map(match => match[1]))];
  const scratch = await fs.mkdtemp(path.resolve(__dirname, '../../develop_tools/out/shield-navigation-'));
  const executable = path.join(scratch, 'shield-check.exe');
  const source = path.join(scratch, 'shield-check.nsi');
  await fs.writeFile(source, String.raw`
Unicode true
!include MUI2.nsh
!include LogicLib.nsh
!define APP_FILENAME "YAB"
!define isUpdated '0 = 1'
!define UAC_IsInnerInstance '0 = 1'
!define UAC_IsAdmin '0 = 1'
!define isForAllUsers '0 = 1'
!define isForCurrentUser '0 = 1'
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION
!define MUI_WELCOMEFINISHPAGE_BITMAP "${path.resolve(__dirname, '../assets/installer-sidebar.bmp')}"
Var installMode
Var hasPerMachineInstallation
Var hasPerUserInstallation
Var perMachineInstallationFolder
Var perUserInstallationFolder
Var report
Var testStep
Var testTheme
!macro UAC_AsUser_GetGlobalVar OUTPUT
  StrCpy @{OUTPUT} 0
!macroend
!macro UAC_RunElevated
  ; No test path may perform real elevation.
  SetErrorLevel 1
  Quit
!macroend
!macro setInstallModePerAllUsers
  StrCpy $installMode "all"
!macroend
!macro setInstallModePerUser
  StrCpy $installMode "current"
!macroend
!macro skipPageIfUpdated
!macroend
!macro yabReadThemePreference OUTPUT
  ClearErrors
  StrCpy @{OUTPUT} $testTheme
!macroend
!include "${path.resolve(__dirname, '../installer.nsh')}"
!include "${modePage}"
Name "YAB shield navigation check"
OutFile "${executable}"
RequestExecutionLevel user
!define MUI_PAGE_CUSTOMFUNCTION_SHOW inspectWelcomeShield
!insertmacro customWelcomePage
!define MUI_PAGE_CUSTOMFUNCTION_SHOW inspectLicenseShield
!insertmacro MUI_PAGE_LICENSE "${path.resolve(__dirname, '../../LICENSE')}"
!define MUI_PAGE_CUSTOMFUNCTION_SHOW inspectModeShield
!insertmacro PAGE_INSTALL_MODE
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE SimpChinese
${messages.map(name => `LangString ${name} @{LANG_SIMPCHINESE} "${name}"`).join('\n')}
!insertmacro customHeader
Function .onInit
  ReadEnvStr $testTheme "YAB_PREVIEW_THEME"
  StrCpy $LANGUAGE @{LANG_SIMPCHINESE}
  StrCpy $installMode "all"
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "0"
  StrCpy $perMachineInstallationFolder ""
  StrCpy $perUserInstallationFolder ""
  StrCpy $testStep 0
  FileOpen $report "$EXEDIR\navigation.txt" w
  !insertmacro customInit
FunctionEnd
Function readShield
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'user32::GetPropW(p r0, w "YAB.Shield") p.r1'
  System::Call 'user32::GetWindowRect(p r0, @r2)'
  System::Call '*$2(i.r3, i, i.r4, i)'
  IntOp $4 $4 - $3
  GetDlgItem $0 $HWNDPARENT 3
  System::Call 'user32::GetWindowRect(p r0, @r2)'
  System::Call '*$2(i.r5, i, i, i)'
  FileWrite $report "layout=$1,$3,$4,$5$\r$\n"
FunctionEnd
Function inspectWelcomeShield
  Call readShield
  FileWrite $report "welcome=$1$\r$\n"
  @{if} $testStep == 1
    StrCpy $testStep 2
  @{endif}
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
FunctionEnd
Function inspectLicenseShield
  Call readShield
  FileWrite $report "license=$1$\r$\n"
  @{if} $testStep == 1
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 3, p 0)'
  @{else}
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 1, p 0)'
  @{endif}
FunctionEnd
Function inspectModeShield
  Call readShield
  FileWrite $report "mode=$1$\r$\n"
  @{if} $testStep == 2
    FileClose $report
    SetErrorLevel 0
    Quit
  @{endif}
  SendMessage $MultiUser.InstallModePage.CurrentUser @{BM_CLICK} 0 0
  Call readShield
  FileWrite $report "current=$1$\r$\n"
  SendMessage $MultiUser.InstallModePage.AllUsers @{BM_CLICK} 0 0
  Call readShield
  FileWrite $report "all=$1$\r$\n"
  Call captureNextButton
  StrCpy $testStep 1
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i @{WM_COMMAND}, p 3, p 0)'
FunctionEnd
Function captureNextButton
  GetDlgItem $0 $HWNDPARENT 1
  ; Hide the focus rectangle so pixel checks measure the icon and caption.
  SendMessage $0 0x128 0x10001 0
  System::Call 'user32::GetDpiForWindow(p r0) i.r2'
  FileWrite $report "dpi=$2$\r$\n"
  System::Call 'user32::GetClientRect(p r0, @r3)'
  System::Call '*$3(i, i, i.R6, i.R7)'
  FileWrite $report "bitmap=$R6,$R7$\r$\n"
  System::Call 'user32::GetDC(p r0) p.r1'
  System::Call 'gdi32::CreateCompatibleDC(p r1) p.R0'
  System::Call '*(i 40, i R6, i R7, &i2 1, &i2 32, i 0, i 0, i 0, i 0, i 0, i 0) p.R8'
  System::Call 'gdi32::CreateDIBSection(p r1, p R8, i 0, *p.R9, p 0, i 0) p.R1'
  System::Free $R8
  System::Call 'gdi32::SelectObject(p R0, p R1) p.R2'
  SendMessage $0 0x318 $R0 4
  System::Call 'kernel32::CreateFileW(w "$EXEDIR\shield.raw", i 0x40000000, i 0, p 0, i 2, i 0x80, p 0) p.r2'
  IntOp $R8 $R6 * $R7
  IntOp $R8 $R8 * 4
  System::Call 'kernel32::WriteFile(p r2, p R9, i R8, *i.r3, p 0)'
  System::Call 'kernel32::CloseHandle(p r2)'
  System::Call 'gdi32::SelectObject(p R0, p R2)'
  System::Call 'gdi32::DeleteObject(p R1)'
  System::Call 'gdi32::DeleteDC(p R0)'
  System::Call 'user32::ReleaseDC(p r0, p r1)'
FunctionEnd
Section
SectionEnd
`.replaceAll('@{', '${'));
  execute(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', source]);
  for (const theme of [0, 1]) {
    execute(executable, [], { env: { ...process.env, YAB_PREVIEW_THEME: String(theme) } });
    const lines = (await fs.readFile(path.join(scratch, 'navigation.txt'), 'utf8')).trim().split(/\r?\n/);
    assert.deepEqual(lines.filter(line => !/^(bitmap|dpi|layout)=/.test(line)), [
      'welcome=0', 'license=0', 'mode=1', 'current=0', 'all=1',
      'license=0', 'welcome=0', 'license=0', 'mode=1',
    ], 'The real install-mode callback owns the shield only while its page is visible.');
    const layouts = lines.filter(line => line.startsWith('layout=')).map(line => line.slice(7).split(',').map(Number));
    const baseline = layouts[0].slice(1);
    for (const [shield, left, width, back] of layouts) {
      if (!shield) {
        assert.deepEqual([left, width, back], baseline, 'Clearing the shield restores the original button row.');
      } else {
        const extra = width - baseline[1];
        assert.ok(extra > 0);
        assert.equal(left, baseline[0] - extra);
        assert.equal(back, baseline[2] - extra, 'The wider Next button must not overlap Back.');
      }
    }
    const dpi = Number(lines.find(line => line.startsWith('dpi=')).slice(4));
    const [width, height] = lines.find(line => line.startsWith('bitmap=')).slice(7).split(',').map(Number);
    const pixels = await fs.readFile(path.join(scratch, 'shield.raw'));
    assert.equal(pixels.length, width * height * 4);
    const yellow = [], ink = [];
    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        const offset = ((height - 1 - y) * width + x) * 4;
        const [blue, green, red] = pixels.subarray(offset, offset + 3);
        if (red > 160 && green > 140 && blue < 130) yellow.push(x);
        if (theme === 0 ? red < 60 && green < 70 && blue < 80 : red > 230 && green > 230 && blue > 230) ink.push(x);
      }
    }
    assert.ok(yellow.length > 0 && ink.length > 0, 'Render both the stock shield and caption.');
    const iconLeft = Math.min(...yellow), iconRight = Math.max(...yellow);
    const text = ink.filter(x => x > iconRight + Math.round(3 * dpi / 96));
    assert.ok(text.length > 0);
    const textLeft = Math.min(...text), textRight = Math.max(...text);
    assert.ok(iconLeft >= Math.round(4 * dpi / 96), 'The shield must have an inset from the button edge.');
    assert.ok(textLeft - iconRight >= Math.round(4 * dpi / 96), 'Leave a visible icon/caption gap.');
    assert.ok(Math.abs(iconLeft - (width - 1 - textRight)) <= Math.round(4 * dpi / 96),
      `Center the rendered group: icon=${iconLeft}..${iconRight}, caption=${textLeft}..${textRight}, width=${width}.`);
    t.diagnostic(`theme=${theme}, dpi=${dpi}: shield=${iconLeft}..${iconRight}, caption=${textLeft}..${textRight}, width=${width}`);
  }
});

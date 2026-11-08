"""Build the x86 native installer control plugin with Visual Studio Build Tools.

Release builds use the checked-in DLL; run this only after changing its source.
Intermediate files are retained under develop_tools/out, never removed here.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    desktop = Path(__file__).resolve().parent
    locator = Path(os.environ.get('ProgramFiles(x86)', 'C:/Program Files (x86)')) / 'Microsoft Visual Studio/Installer/vswhere.exe'
    installation = subprocess.check_output([str(locator), '-latest', '-products', '*', '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], text=True).strip()
    if not installation:
        raise SystemExit('请安装 Visual Studio 的 C++ 桌面构建工具')
    output = desktop.parent / 'develop_tools/out'
    output.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix='installer-native-', dir=output))
    exports = scratch / 'exports.def'
    exports.write_text('LIBRARY YabInstallUI\nEXPORTS\n Apply\n Progress\n Stage\n Phase\n Complete\n', encoding='ascii')
    assets = desktop / 'assets/checkbox'
    manifest = json.loads((assets / 'manifest.json').read_text(encoding='utf-8'))
    inputs = {desktop / 'native/checkbox-assets.h': manifest['headerSha256']}
    inputs.update({assets / 'source' / name: digest for name, digest in manifest['sources'].items()})
    inputs.update({assets / entry['file']: entry['sha256'] for entry in manifest['resources']})
    for filename, expected in inputs.items():
        if hashlib.sha256(filename.read_bytes()).hexdigest() != expected:
            raise SystemExit(f'复选框素材校验失败，请重新生成：{filename.name}')
    resources = scratch / 'checkbox.rc'
    resources.write_text('\n'.join(f'{entry["id"]} RCDATA "{(assets / entry["file"]).as_posix()}"'
        for entry in manifest['resources']) + '\n', encoding='utf-8')
    compiled_resources = scratch / 'checkbox.res'
    response = scratch / 'compile.rsp'
    arguments = ['/nologo', '/LD', '/MT', '/O2', '/W4', '/WX', '/utf-8', '/DUNICODE', '/D_UNICODE',
        '/D_WIN32_WINNT=0x0A00', '"' + str(desktop / 'native/installer-ui.cpp') + '"',
        '"' + str(compiled_resources) + '"', '/link',
        '/DEF:"' + str(exports) + '"', '/OUT:"' + str(desktop / 'assets/YabInstallUI.dll') + '"',
        'user32.lib', 'gdi32.lib', 'gdiplus.lib', 'comctl32.lib', 'uxtheme.lib', 'shell32.lib', 'dwmapi.lib', 'shlwapi.lib']
    response.write_text(' '.join(arguments), encoding='utf-8')
    setup = Path(installation) / 'VC/Auxiliary/Build/vcvarsall.bat'
    command = scratch / 'build.cmd'
    command.write_text(f'@echo off\ncall "{setup}" x86 >nul\nif errorlevel 1 exit /b %errorlevel%\n'
        f'rc /nologo /fo "{compiled_resources}" "{resources}"\nif errorlevel 1 exit /b %errorlevel%\n'
        f'cl @"{response}"\n', encoding='mbcs')
    subprocess.run([os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', 'build.cmd'], cwd=scratch, check=True)
    print('已生成安装器控件库；中间文件保留于', scratch)


if __name__ == '__main__':
    main()

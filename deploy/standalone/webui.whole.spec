# -*- mode: python ; coding: utf-8 -*-

# PyInstaller spec for the WebUI entry (webui.py -> python -m server).
# Build the frontend first: cd webapp && pnpm install && pnpm build
# Move this spec to the project root before running pyinstaller.

import os

datas = []
if os.path.exists('webapp/dist'):
    datas += [('webapp/dist', 'webapp/dist')]
if os.path.exists('src/maatouch_bin'):
    datas += [('src/maatouch_bin', 'src/maatouch_bin')]

a = Analysis(
    ['webui.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='BAAS',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='assets/logo.ico',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='BAAS',
)

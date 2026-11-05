# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files

root = Path(SPECPATH).parent
ocr = root / 'core/ocr/baas_ocr_client/bin'
if not (root / 'webapp/dist/index.html').is_file():
    raise RuntimeError('请先构建网页资源')
if not (ocr / 'BAAS_ocr_server.exe').is_file():
    raise RuntimeError('请先按源码方式启动一次，准备 OCR 识别程序和模型')

# Include only distributable resources. User configs, logs, credentials and Git
# metadata are deliberately absent from this allowlist.
datas = [(str(root / item), item) for item in ('src', 'assets', 'webapp/dist')]
datas += [(str(ocr / 'resource'), 'core/ocr/baas_ocr_client/bin/resource')]
datas += [(str(file), 'core/ocr/baas_ocr_client/bin') for file in ocr.iterdir()
          if file.is_file() and file.suffix.lower() in ('.exe', '.dll')]
datas += collect_data_files('adbutils') + collect_data_files('uiautomator2')
hiddenimports = ['main', 'uvicorn.logging', 'uvicorn.loops.asyncio',
                 'uvicorn.protocols.http.h11_impl', 'uvicorn.protocols.websockets.websockets_impl',
                 'uvicorn.lifespan.on']
for file in (root / 'src/images').rglob('*.py'):
    module = file.relative_to(root).with_suffix('').parts
    hiddenimports.append('.'.join(module[:-1] if module[-1] == '__init__' else module))

a = Analysis([str(root / 'webui.py')], pathex=[str(root)], binaries=[], datas=datas,
             hiddenimports=hiddenimports, hookspath=[], hooksconfig={}, runtime_hooks=[],
             excludes=['PyQt5', 'PySide2', 'PySide6', 'tkinter', 'matplotlib', 'pytest'],
             noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='BAAS',
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=True, icon=str(root / 'assets/logo.ico'), contents_directory='.')
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='BAAS')

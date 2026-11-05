"""Build the source checkout's WebUI, reusing packaged assets when present."""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _supports_node(version):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', version.strip())
    if match is None:
        return False
    major, minor, _ = map(int, match.groups())
    return (major == 20 and minor >= 19) or (major == 22 and minor >= 12) or major >= 24


def ensure_frontend(root=None, force=False):
    root = Path(root) if root is not None else PROJECT_ROOT
    webapp = root / 'webapp'
    index = webapp / 'dist' / 'index.html'
    inputs = [webapp / name for name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html',
                                         'vite.config.ts', 'svelte.config.js', 'tsconfig.json')]
    inputs.extend((webapp / 'src').rglob('*'))
    if (not force and index.is_file()
            and all(path.stat().st_mtime <= index.stat().st_mtime for path in inputs if path.is_file())):
        return
    if getattr(sys, 'frozen', False):
        raise RuntimeError('发行包缺少网页资源，请重新下载完整发行包')
    if not (webapp / 'package.json').is_file():
        raise RuntimeError('缺少网页源文件，请使用完整源码或发行包')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('源码启动需要 Node.js（网页构建运行环境），请安装后重新打开终端')
    version = subprocess.check_output([node, '--version'], text=True).strip()
    if not _supports_node(version):
        raise RuntimeError(f'当前 Node.js 版本 {version} 不支持 Vite 8，请安装 22.12 以上的 22 系列或 24 以上版本')
    pnpm = shutil.which('pnpm')
    if not pnpm:
        raise RuntimeError('源码启动需要 pnpm（前端依赖管理工具），请安装后重新打开终端，版本可自行选择')
    print('正在使用本机环境准备网页界面，首次启动需要下载前端依赖……', flush=True)
    for args in (['install', '--frozen-lockfile'], ['run', 'build', '--emptyOutDir', 'false']):
        subprocess.run([pnpm] + args, cwd=webapp, check=True)
    if not index.is_file():
        raise RuntimeError('网页构建没有生成首页')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='准备 BAAS 网页资源')
    parser.add_argument('--force', action='store_true', help='重新构建网页资源')
    ensure_frontend(force=parser.parse_args().force)

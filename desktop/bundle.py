"""Build a source bundle with standalone Python, uv and an offline wheelhouse."""

import argparse
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parent.parent
OCR = Path('core/ocr/baas_ocr_client/bin')


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True, **kwargs)


def copy_filter(directory, names):
    return [name for name in names if name == '__pycache__' or name.startswith('.')
            or name.endswith(('.pyc', '.pyo', '.log'))]


def build_bundle(output, cache, uv):
    output.mkdir(parents=True)
    cache.mkdir(parents=True, exist_ok=True)
    os.environ['UV_CACHE_DIR'] = str(cache / 'uv')
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    version = json.loads((ROOT / 'desktop/package.json').read_text(encoding='utf-8'))['version']
    python_version = (ROOT / 'desktop/python-version').read_text().strip()
    if not (ROOT / OCR / 'BAAS_ocr_server.exe').is_file():
        raise RuntimeError('请先按源码方式启动一次，准备识别程序和模型')
    if not (ROOT / 'webapp/dist/index.html').is_file():
        raise RuntimeError('发行包缺少预构建网页')

    # A managed Python installation is relocatable; a copied developer venv is not.
    find = [uv, 'python', 'find', '--system', '--managed-python', '--no-python-downloads', python_version]
    result = subprocess.run(find, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        os.environ['UV_PYTHON_INSTALL_DIR'] = str(cache / 'python')
        run([uv, 'python', 'install', python_version])
        result = run(find, capture_output=True, text=True)
    python = Path(result.stdout.strip()).resolve()
    info = run([python, '-I', '-c', 'import sys; print(sys.version.split()[0])'], capture_output=True, text=True)
    if info.stdout.strip() != python_version:
        raise RuntimeError('独立解释器版本与发行配置不符')

    toolkit = output / 'toolkit'
    toolkit.mkdir()
    shutil.copytree(python.parent, toolkit / 'python', ignore=copy_filter)
    shutil.copy2(uv, toolkit / 'uv.exe')

    # Build source-only dependencies once on the maintainer's machine. All user
    # installations subsequently use these exact wheels, without an index or compiler.
    key = hashlib.sha256((sha256(ROOT / 'uv.lock') + python_version).encode()).hexdigest()
    wheel_cache = cache / 'wheels' / key
    if not (wheel_cache / '.ready').is_file():
        import uuid
        work = cache / ('wheel-build-' + uuid.uuid4().hex)
        work.mkdir()
        requirements = work / 'locked.txt'
        run([uv, 'export', '--locked', '--no-dev', '--no-default-groups', '--no-emit-project',
             '--no-header', '--no-annotate', '-o', requirements], stdout=subprocess.DEVNULL)
        run([uv, 'venv', '--python', python, work / 'env'])
        run([uv, 'pip', 'install', '--python', work / 'env/Scripts/python.exe',
             'pip==25.3', 'setuptools==69.5.1', 'wheel==0.45.1'])
        run([work / 'env/Scripts/python.exe', '-I', '-m', 'pip', 'wheel', '--no-deps',
             '--no-input', '--disable-pip-version-check', '--cache-dir', cache / 'pip',
             '--no-build-isolation',
             '--require-hashes', '-r', requirements, '--wheel-dir', work / 'wheels'])
        # Never replace or delete an interrupted build; keep it for inspection.
        wheel_cache.mkdir(parents=True, exist_ok=True)
        shutil.copytree(work / 'wheels', wheel_cache, dirs_exist_ok=True)
        (wheel_cache / '.ready').write_text('ok', encoding='utf-8')
    wheels = output / 'wheels'
    wheels.mkdir()
    requirements = []
    for wheel in sorted(wheel_cache.glob('*.whl')):
        shutil.copy2(wheel, wheels / wheel.name)
        with zipfile.ZipFile(wheel) as archive:
            metadata_path = next(n for n in archive.namelist() if n.endswith('.dist-info/METADATA'))
            metadata = BytesParser().parsebytes(archive.read(metadata_path))
        requirements.append(f"{metadata['Name']}=={metadata['Version']} --hash=sha256:{sha256(wheel)}")
    if not requirements:
        raise RuntimeError('离线依赖包为空')
    (output / 'requirements.txt').write_text('\n'.join(requirements) + '\n', encoding='utf-8')

    app = output / 'app'
    app.mkdir()
    for directory in ('core', 'module', 'server', 'src', 'assets'):
        def source_filter(current, names):
            ignored = copy_filter(current, names)
            if Path(current).resolve() == (ROOT / OCR).parent.resolve():
                ignored.append('bin')
            return ignored
        shutil.copytree(ROOT / directory, app / directory, ignore=source_filter)
    for filename in ('main.py', 'webui.py', 'pyproject.toml', 'uv.lock', 'LICENSE', 'README.md'):
        shutil.copy2(ROOT / filename, app / filename)
    shutil.copytree(ROOT / 'webapp/dist', app / 'webapp/dist', ignore=copy_filter)
    ocr = app / OCR
    ocr.mkdir(parents=True)
    shutil.copytree(ROOT / OCR / 'resource', ocr / 'resource', ignore=copy_filter)
    for file in (ROOT / OCR).iterdir():
        if file.is_file() and file.suffix.lower() in ('.exe', '.dll'):
            shutil.copy2(file, ocr / file.name)
    (app / 'distribution.json').write_text(json.dumps({'version': version, 'format': 1}), encoding='utf-8')

    files = {file.relative_to(output).as_posix(): sha256(file)
             for file in sorted(output.rglob('*')) if file.is_file()}
    runtime_files = {name: digest for name, digest in files.items() if not name.startswith('app/')}
    runtime_key = hashlib.sha256(json.dumps(runtime_files, sort_keys=True).encode()).hexdigest()
    bundle_id = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    manifest = {'format': 2, 'id': bundle_id, 'version': version,
                'python': python_version, 'runtimeKey': runtime_key, 'files': files}
    (output / 'bundle.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f'源码发行包准备完成：{output}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--uv', required=True, type=Path)
    args = parser.parse_args()
    build_bundle(args.output.resolve(), args.cache.resolve(), args.uv.resolve())

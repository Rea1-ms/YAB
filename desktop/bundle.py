"""Build offline or online source distributions without copying a developer venv."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from email.parser import BytesParser
from pathlib import Path

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


def build_bundle(output, cache, uv, mode='offline', system_uv=False, application=None):
    output.mkdir(parents=True)
    cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault('UV_CACHE_DIR', str(cache / 'uv'))
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    source = ROOT if application is None else application
    metadata = source / ('desktop/package.json' if application is None else 'distribution.json')
    version = json.loads(metadata.read_text(encoding='utf-8'))['version']
    python_version = (ROOT / 'desktop/python-version').read_text().strip()
    if not (source / OCR / 'BAAS_ocr_server.exe').is_file():
        raise RuntimeError('请先按源码方式启动一次，准备识别程序和模型')
    frontend = source / 'webapp/dist'
    if not (frontend / 'index.html').is_file():
        raise RuntimeError('发行包缺少预构建网页')

    # Export dependencies before computing their key: changing only the application
    # version must not invalidate the complete wheelhouse.
    locked = output / 'requirements.txt'
    export = [uv, 'export', '--locked', '--no-dev', '--no-default-groups', '--no-emit-project',
              '--no-header', '--no-annotate', '-o', locked]
    if application is not None:
        export += ['--project', application, '--python', sys.executable]
    run(export, stdout=subprocess.DEVNULL)
    toolkit = output / 'toolkit'
    toolkit.mkdir()
    if not system_uv:
        shutil.copy2(uv, toolkit / 'uv.exe')
    if mode == 'offline':
        prepare_offline_dependencies(output, cache, uv, python_version, locked, toolkit)
    else:
        # Keep legacy source builds compatible with the offline build toolchain.
        (output / 'build-constraints.txt').write_text(
            'setuptools==69.5.1\nwheel==0.45.1\n', encoding='utf-8')

    runtime_files = {file.relative_to(output).as_posix(): sha256(file)
                     for file in sorted(output.rglob('*')) if file.is_file()}
    if application is None:
        application = output / 'app'
        copy_application(application, version, frontend)
    files = dict(runtime_files)
    files.update({f'app/{file.relative_to(application).as_posix()}': sha256(file)
                  for file in sorted(application.rglob('*')) if file.is_file()})
    if mode == 'online':
        # Tool location and mirror selection do not change the locked environment.
        runtime_files = {name: digest for name, digest in runtime_files.items() if not name.startswith('toolkit/')}
        runtime_files['python'] = python_version
        runtime_files['policy'] = 'online-v1'
    runtime_key = hashlib.sha256(json.dumps(runtime_files, sort_keys=True).encode()).hexdigest()
    bundle_id = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    manifest = {'format': 2 if mode == 'offline' else 3, 'id': bundle_id, 'version': version,
                'python': python_version, 'runtimeKey': runtime_key, 'files': dict(sorted(files.items()))}
    if mode == 'online':
        manifest.update(mode='online', uv='system' if system_uv else 'bundled')
    (output / 'bundle.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f'源码发行包准备完成：{output}', flush=True)


def prepare_offline_dependencies(output, cache, uv, python_version, locked, toolkit):
    # A managed Python installation is relocatable; a copied developer venv is not.
    find = [uv, 'python', 'find', '--system', '--managed-python', '--no-python-downloads', python_version]
    result = subprocess.run(find, check=False, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        os.environ['UV_PYTHON_INSTALL_DIR'] = str(cache / 'python')
        run([uv, 'python', 'install', python_version])
        result = run(find, capture_output=True, text=True)
    python = Path(result.stdout.strip()).resolve()
    info = run([python, '-I', '-c', 'import sys; print(sys.version.split()[0])'], capture_output=True, text=True)
    if info.stdout.strip() != python_version:
        raise RuntimeError('独立解释器版本与发行配置不符')

    shutil.copytree(python.parent, toolkit / 'python', ignore=copy_filter)

    # Build source-only dependencies once on the maintainer's machine. All user
    # installations subsequently use these exact wheels, without an index or compiler.
    key = hashlib.sha256((sha256(locked) + python_version).encode()).hexdigest()
    wheel_cache = cache / 'wheels' / key
    if not (wheel_cache / '.ready').is_file():
        import uuid
        work = cache / ('wheel-build-' + uuid.uuid4().hex)
        work.mkdir()
        requirements = work / 'locked.txt'
        shutil.copy2(locked, requirements)
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


def application_filter(directory, names):
    ignored = copy_filter(directory, names)
    if Path(directory).resolve() == (ROOT / OCR).parent.resolve():
        ignored.append('bin')
    return ignored


def application_sources(frontend):
    for name in ('core', 'module', 'server', 'src', 'assets'):
        yield ROOT / name, Path(name), application_filter
    for name in ('main.py', 'webui.py', 'pyproject.toml', 'uv.lock', 'LICENSE', 'README.md'):
        yield ROOT / name, Path(name), None
    yield frontend, Path('webapp/dist'), copy_filter
    yield ROOT / OCR / 'resource', OCR / 'resource', copy_filter
    for file in (ROOT / OCR).iterdir():
        if file.is_file() and file.suffix.lower() in ('.exe', '.dll'):
            yield file, OCR / file.name, None


def copy_application(app, version, frontend):
    app.mkdir()
    for source, relative, ignore in application_sources(frontend):
        if ignore is None:
            shutil.copy2(source, app / relative)
        else:
            shutil.copytree(source, app / relative, ignore=ignore)
    (app / 'distribution.json').write_text(json.dumps({'version': version, 'format': 1}), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--uv', required=True, type=Path)
    parser.add_argument('--mode', choices=('offline', 'online'), default='offline')
    parser.add_argument('--system-uv', action='store_true')
    args = parser.parse_args()
    if args.system_uv and args.mode != 'online':
        parser.error('--system-uv 仅适用于轻量包')
    build_bundle(args.output.resolve(), args.cache.resolve(), args.uv.resolve(), args.mode, args.system_uv)

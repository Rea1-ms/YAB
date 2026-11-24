"""Prepare shared, immutable desktop build inputs."""

import argparse
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from desktop import bundle
from server.frontend import ensure_frontend, frontend_inputs


def fingerprint(files, options=()):
    data = json.dumps([dict(files), options], sort_keys=True).encode()
    return hashlib.sha256(data).hexdigest()


def input_files(source, relative, ignore):
    if ignore is None:
        yield relative.as_posix(), bundle.sha256(source)
        return
    for directory, subdirs, filenames in os.walk(source, followlinks=True):
        ignored = ignore(directory, subdirs + filenames)
        subdirs[:] = sorted(name for name in subdirs if name not in ignored)
        parent = Path(directory)
        for name in filenames:
            if name not in ignored:
                file = parent / name
                yield (relative / file.relative_to(source)).as_posix(), bundle.sha256(file)


def cached_output(parent, signature, marker, build):
    key = signature()
    output = parent / key
    if (output / marker).is_file():
        print(f'复用构建产物：{output}', flush=True)
        return output
    parent.mkdir(parents=True, exist_ok=True)
    pending = parent / f'.pending-{uuid4().hex}'
    build(pending)
    if not (pending / marker).is_file() or signature() != key:
        raise RuntimeError(f'构建期间输入发生变化或产物不完整：{pending}')
    try:
        pending.rename(output)
    except OSError:
        if not (output / marker).is_file():
            raise
    return output


def prepare_frontend(cache, node_version):
    webapp = bundle.ROOT / 'webapp'

    def signature():
        inputs = frontend_inputs(webapp)
        inputs += [webapp / name for name in ('.env', '.env.local', '.env.production', '.env.production.local')]
        files = [(file.relative_to(webapp).as_posix(), bundle.sha256(file)) for file in inputs if file.is_file()]
        environment = {name: value for name, value in os.environ.items()
                       if name == 'NODE_ENV' or name.startswith('VITE_')}
        return fingerprint(files, [node_version, environment, bundle.sha256(Path(__file__)),
                                   bundle.sha256(bundle.ROOT / 'server/frontend.py')])

    return cached_output(cache / 'frontend', signature, 'index.html',
                         lambda output: ensure_frontend(bundle.ROOT, force=True, destination=output))


def prepare_application(cache, frontend):
    metadata = bundle.ROOT / 'desktop/package.json'

    def signature():
        files = []
        for source, relative, ignore in bundle.application_sources(frontend):
            files.extend(input_files(source, relative, ignore))
        return fingerprint(files, [bundle.sha256(metadata), bundle.sha256(Path(bundle.__file__)),
                                   bundle.sha256(Path(__file__))])

    def build(output):
        version = json.loads(metadata.read_text(encoding='utf-8'))['version']
        bundle.copy_application(output, version, frontend)

    return cached_output(cache / 'application', signature, 'distribution.json', build)


def prepare_backend(cache, application, uv, mode, system_uv):
    def signature():
        files = []
        for name in ('desktop/python-version', 'desktop/bundle.py', 'desktop/build_cache.py'):
            files.append((name, bundle.sha256(bundle.ROOT / name)))
        return fingerprint(files, [application.name, mode, system_uv, bundle.sha256(uv)])

    return cached_output(cache / 'backend', signature, 'bundle.json',
                         lambda output: bundle.build_bundle(output, cache, uv, mode, system_uv, application))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input', choices=('frontend', 'backend'))
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--node-version', required=True)
    parser.add_argument('--uv', type=Path)
    parser.add_argument('--mode', choices=('offline', 'online'), default='offline')
    parser.add_argument('--system-uv', action='store_true')
    args = parser.parse_args()
    if args.input == 'backend' and args.uv is None:
        parser.error('--uv is required for backend builds')
    if args.system_uv and args.mode != 'online':
        parser.error('--system-uv is only supported for online builds')
    cache = args.cache.resolve()
    frontend = prepare_frontend(cache, args.node_version)
    output = str(frontend)
    if args.input == 'backend':
        application = prepare_application(cache, frontend)
        backend = prepare_backend(cache, application, args.uv.resolve(), args.mode, args.system_uv)
        output = {'backend': str(backend), 'application': str(application)}
    print(f'YAB_BUILD_INPUT {json.dumps(output)}')


if __name__ == '__main__':
    main()

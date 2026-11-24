"""Manage temporary test data and completed reports."""

import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'develop_tools/out'
RESULTS = OUTPUT / 'results'
ARCHIVE = ROOT / '.cache/test-results'
REPORT_GROUPS = ('offline-tests', 'desktop-tests', 'online-smoke')
RETENTION_SECONDS = 7 * 24 * 60 * 60


def local_directory(path):
    if path.resolve() != path:
        raise ValueError(f'测试输出不应通过目录链接写入：{path}')
    return path


def new_test_directory(test, prefix):
    scratch = local_directory(OUTPUT / 'tmp')
    scratch.mkdir(parents=True, exist_ok=True)
    directory = tempfile.TemporaryDirectory(prefix=prefix, dir=scratch)
    test.addCleanup(directory.cleanup)
    return Path(directory.name)


def archive_test_results():
    cutoff = time.time() - RETENTION_SECONDS
    archived = []
    for group in REPORT_GROUPS:
        source = local_directory(RESULTS / group)
        if not source.exists():
            continue
        destination = local_directory(ARCHIVE / group)
        for run in source.iterdir():
            marker = run / '.complete'
            if not run.name.startswith('run-') or run.resolve() != run or marker.is_symlink():
                continue
            try:
                if not marker.is_file() or marker.stat().st_mtime > cutoff:
                    continue
                target = destination / run.name
                if target.exists() or target.is_symlink():
                    continue
                destination.mkdir(parents=True, exist_ok=True)
                run.rename(target)
                archived.append(target)
            except FileNotFoundError:
                # Another test process may already have archived this run.
                if run.exists():
                    raise
    return archived


def main():
    try:
        for path in archive_test_results():
            print(f'已归档测试结果：{path}')
    except (OSError, ValueError) as error:
        print(f'测试结果归档失败：{error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

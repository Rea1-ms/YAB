"""Run the explicitly registered offline regressions and retain diagnostics."""

import argparse
import hashlib
import json
import shutil
import sys
import time
import unittest
from datetime import datetime
from functools import partial
from pathlib import Path
from uuid import uuid4

import cv2

from develop_tools.test.offline_support import (
    ROOT,
    begin_case,
    end_case,
    fixture_path,
    fixture_registry,
    offline_guard,
    recognition_diagnostics,
    validate_fixtures,
)

SUITES = {
    'popups': ('develop_tools.test.test_main_page_popups',),
    'activity': ('develop_tools.test.test_current_activity',),
    'shop': ('develop_tools.test.test_shop_selection',),
    'drill': ('develop_tools.test.test_joint_firing_drill',),
    'version': ('develop_tools.test.test_version_info',),
    'screenshot': ('develop_tools.test.test_screenshot_failures',),
    'infrastructure': ('develop_tools.test.test_offline_runner', 'develop_tools.test.test_task_errors'),
}


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def select_cases(suite='all', case=None):
    modules = [module for group in SUITES.values() for module in group] if case or suite == 'all' else SUITES[suite]
    loader = unittest.TestLoader()
    cases = list(flatten(loader.loadTestsFromNames(modules)))
    if loader.errors:
        raise ValueError('\n'.join(loader.errors))
    if case:
        cases = [test for test in cases if test.id() == case]
    if not cases:
        raise ValueError('没有找到已登记的离线用例')
    return cases


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, value):
        for stream in self.streams:
            stream.write(value)

    def flush(self):
        for stream in self.streams:
            stream.flush()


class OfflineResult(unittest.TextTestResult):
    def __init__(self, *args, destination, **kwargs):
        super().__init__(*args, **kwargs)
        self.destination = Path(destination)
        self.records = []

    def startTest(self, test):
        self.state, self.token = begin_case()
        self.record = {'id': test.id(), 'status': 'passed', 'details': [], 'attachments': []}
        self.started = time.perf_counter()
        super().startTest(test)

    def stopTest(self, test):
        self.record['duration_seconds'] = round(time.perf_counter() - self.started, 4)
        self.record['diagnostics'] = {key: value for key, value in self.state.items() if key != 'last_image'}
        self.records.append(self.record)
        end_case(self.token)
        super().stopTest(test)

    def capture_failure(self, test, err):
        self.record['status'] = 'failed' if issubclass(err[0], AssertionError) else 'error'
        self.record['details'].append(self._exc_info_to_string(err, test))
        try:
            folder = self.destination / 'failures' / hashlib.sha256(test.id().encode()).hexdigest()[:12]
            folder.mkdir(parents=True, exist_ok=True)
            frame = self.state['last_image']
            if frame is not None:
                ok, encoded = cv2.imencode('.png', frame)
                if ok:
                    path = folder / f'frame-{len(self.record["details"])}.png'
                    path.write_bytes(encoded.tobytes())
                    self.record['attachments'].append(str(path.relative_to(self.destination)))
            registry = fixture_registry()
            for name in self.state['fixtures']:
                path = folder / f'{name}.png'
                if not path.exists():
                    shutil.copyfile(fixture_path(name, registry[name]), path)
                    self.record['attachments'].append(str(path.relative_to(self.destination)))
        except (OSError, ValueError, KeyError, cv2.error) as exc:
            self.record['details'].append(f'失败附件保存异常：{exc}')

    def addFailure(self, test, err):
        self.capture_failure(test, err)
        super().addFailure(test, err)

    def addError(self, test, err):
        self.capture_failure(test, err)
        super().addError(test, err)

    def addSubTest(self, test, subtest, err):
        if err is not None:
            self.capture_failure(test, err)
            self.record['details'].append(str(subtest))
        super().addSubTest(test, subtest, err)

    def addSkip(self, test, reason):
        if self.record['status'] == 'passed':
            self.record['status'] = 'skipped'
        self.record['details'].append(reason)
        super().addSkip(test, reason)

    def addExpectedFailure(self, test, err):
        self.capture_failure(test, err)
        super().addExpectedFailure(test, err)

    def addUnexpectedSuccess(self, test):
        self.record['status'] = 'failed'
        self.record['details'].append('标为预期失败的用例意外通过，请更新用例约定')
        super().addUnexpectedSuccess(test)


def successful(result):
    return result.wasSuccessful() and not result.skipped and all(
        record['status'] == 'passed' for record in result.records
    )


def output_directory(value=None):
    parent = ROOT / 'develop_tools/out/offline-tests'
    path = Path(value).resolve() if value else parent / f'{datetime.now():%Y%m%d-%H%M%S}-{uuid4().hex[:8]}'
    if not path.is_relative_to(ROOT):
        raise ValueError('报告目录必须位于当前仓库内')
    path.mkdir(parents=True, exist_ok=False)
    return path


def write_report(destination, report):
    with (destination / 'result.json').open('w', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description='批量运行已登记的离线截图与流程回归')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--suite', choices=('all', *SUITES), default='all')
    group.add_argument('--case', help='已登记用例的完整标识')
    parser.add_argument('--list', action='store_true', help='仅列出用例')
    parser.add_argument('--out', help='新的报告目录，不覆盖已有内容')
    args = parser.parse_args(argv)
    destination = None
    try:
        with offline_guard():
            cases = select_cases(args.suite, args.case)
            if args.list:
                for test in cases:
                    print(test.id())
                print(f'共 {len(cases)} 项；未运行测试')
                return 0
            destination = output_directory(args.out)
            registry = validate_fixtures()
            with (destination / 'output.log').open('w', encoding='utf-8', newline='\n') as logfile, \
                    recognition_diagnostics():
                runner = unittest.TextTestRunner(
                    stream=Tee(sys.stdout, logfile), verbosity=2,
                    resultclass=partial(OfflineResult, destination=destination),
                )
                result = runner.run(unittest.TestSuite(cases))
            counts = {status: sum(record['status'] == status for record in result.records)
                      for status in ('passed', 'failed', 'error', 'skipped')}
            report = {'version': 1, 'suite': args.suite, 'case': args.case, 'python': sys.version.split()[0],
                      'fixture_count': len(registry), 'counts': counts, 'tests': result.records}
            write_report(destination, report)
            print(f'离线结果：{counts}；报告：{destination}')
            return 0 if successful(result) and len(result.records) == len(cases) else 1
    except (OSError, ValueError, ImportError) as exc:
        message = f'离线测试准备失败：{exc}'
        if destination is not None:
            try:
                write_report(destination, {'version': 1, 'status': 'preparation_error', 'error': str(exc)})
            except OSError as report_error:
                print(f'准备失败报告无法保存：{report_error}', file=sys.stderr)
        print(message, file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

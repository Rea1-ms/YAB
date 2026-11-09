"""Contracts for sample integrity, replay isolation and failure diagnostics."""

import hashlib
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from functools import partial
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from develop_tools.run_offline_tests import (
    OfflineResult,
    main,
    output_directory,
    select_cases,
    successful,
)
from develop_tools.test.offline_support import (
    ROOT,
    FrameReplay,
    ReplayClock,
    begin_case,
    end_case,
    fixture_registry,
    load_fixture,
    offline_guard,
    recognition_diagnostics,
    validate_fixtures,
)


class OfflineRunnerTests(unittest.TestCase):
    def test_default_collection_excludes_interactive_emulator_tests(self):
        ids = [case.id() for case in select_cases()]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertFalse(any('test_explore_' in name for name in ids))
        self.assertTrue(any('test_main_page_popups' in name for name in ids))

    def test_undefined_feature_keeps_original_recognition_result(self):
        from core import image, position

        state, token = begin_case()
        self.addCleanup(end_case, token)
        worker = SimpleNamespace(identifier='diagnostic-test', latest_img_array=None)
        with patch.dict(position.image_dic, {'diagnostic-test': {}}), recognition_diagnostics():
            self.assertFalse(image.compare_image(worker, 'unknown-feature'))
            self.assertFalse(image.compare_image(worker, 'missing_feature'))
        self.assertTrue(state['checks'])
        self.assertTrue(all(check['area'] is None for check in state['checks']))
        self.assertTrue(all(not check['matched'] for check in state['checks']))

    def test_fixture_consumers_are_registered_cases(self):
        ids = {case.id() for case in select_cases()}
        for name, metadata in validate_fixtures().items():
            with self.subTest(fixture=name):
                self.assertTrue(set(metadata['used_by']) <= ids)

    def test_malformed_manifest_metadata_is_rejected(self):
        with patch('pathlib.Path.read_text', return_value='[]'), self.assertRaises(ValueError):
            fixture_registry()
        original = fixture_registry()['global_startup_promo_20261108']
        for changes in ({'path': '../outside.png'}, {'sha256': 'invalid'},
                        {'size': [0, 720]}, {'used_by': 'not-a-list'}):
            metadata = dict(original, **changes)
            with self.subTest(changes=changes), \
                    patch('develop_tools.test.offline_support.fixture_registry', return_value={'invalid': metadata}), \
                    self.assertRaises(ValueError):
                validate_fixtures()

    def test_unknown_case_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '没有找到'):
            select_cases(case='develop_tools.test.test_explore_normal_task.TestExploreNormalTask.test_explore_normal_task')

    def test_unregistered_screenshot_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '未登记'):
            load_fixture('not-registered')

    def test_missing_screenshot_is_an_error(self):
        with patch('pathlib.Path.read_bytes', side_effect=FileNotFoundError('missing sample')), \
                self.assertRaises(FileNotFoundError):
            load_fixture('global_startup_promo_20261108')

    def test_changed_screenshot_is_an_error(self):
        with patch('pathlib.Path.read_bytes', return_value=b'corrupted screenshot'), \
                self.assertRaisesRegex(ValueError, '校验值不一致'):
            load_fixture('global_startup_promo_20261108')

    def test_undecodable_or_wrong_size_screenshot_is_an_error(self):
        name = 'global_startup_promo_20261108'
        metadata = dict(fixture_registry()[name])
        with patch('develop_tools.test.offline_support.fixture_registry', return_value={name: metadata}):
            metadata['size'] = [1, 1]
            with self.assertRaisesRegex(ValueError, '尺寸不一致'):
                load_fixture(name)
            raw = b'not a png'
            metadata['sha256'] = hashlib.sha256(raw).hexdigest()
            with patch('pathlib.Path.read_bytes', return_value=raw), \
                    self.assertRaisesRegex(ValueError, '损坏'):
                load_fixture(name)

    def test_click_does_not_advance_observations_and_exhaustion_fails(self):
        frame = load_fixture('global_startup_promo_20261108')
        replay = FrameReplay([frame], ReplayClock())
        replay.click(1173, 75)
        self.assertEqual(replay.index, -1)
        self.assertIs(replay.screenshot(), frame)
        replay.click(1173, 75)
        self.assertEqual(replay.index, 0)
        with self.assertRaisesRegex(AssertionError, '回放帧已用完'):
            replay.screenshot()

    def test_real_device_and_account_config_are_rejected(self):
        import uiautomator2
        from adbutils import AdbClient

        from core.config.config_set import ConfigSet
        from core.device.connection import Connection

        with offline_guard():
            for operation in (lambda: Connection(None), lambda: ConfigSet('cn'),
                              lambda: AdbClient().device_list(), lambda: uiautomator2.connect()):
                with self.subTest(operation=operation), self.assertRaisesRegex(AssertionError, '不允许连接'):
                    operation()

    def test_failure_retains_screenshot_actions_and_expected_result(self):
        destination = ROOT / 'develop_tools/out/offline-tests' / f'contract-{uuid4().hex[:8]}'
        destination.mkdir(parents=True)

        class DeliberateFailure(unittest.TestCase):
            def runTest(self):
                replay = FrameReplay([load_fixture('global_startup_promo_20261108')], ReplayClock())
                replay.screenshot()
                replay.click(1173, 75)
                with self.subTest(scene='reported-startup'):
                    self.assertEqual([1238, 45], [1173, 75])

        result = unittest.TextTestRunner(
            stream=io.StringIO(), resultclass=partial(OfflineResult, destination=destination),
        ).run(unittest.TestSuite([DeliberateFailure()]))
        self.assertFalse(successful(result))
        record = result.records[0]
        self.assertEqual(record['status'], 'failed')
        self.assertIn('1173', ''.join(record['details']))
        self.assertEqual(record['diagnostics']['actions'][0]['position'], [1173, 75])
        self.assertTrue(record['attachments'])
        self.assertTrue(all((destination / path).is_file() for path in record['attachments']))
        self.assertIn('global_startup_promo_20261108', fixture_registry())

    def test_skipped_case_is_not_success(self):
        class Skipped(unittest.TestCase):
            def runTest(self):
                self.skipTest('controlled skip')

        result = unittest.TextTestRunner(
            stream=io.StringIO(), resultclass=partial(OfflineResult, destination=ROOT),
        ).run(unittest.TestSuite([Skipped()]))
        self.assertFalse(successful(result))
        self.assertEqual(result.records[0]['status'], 'skipped')

    def test_expected_failure_is_not_a_passing_regression(self):
        class ExpectedFailure(unittest.TestCase):
            @unittest.expectedFailure
            def runTest(self):
                self.fail('known failure')

        result = unittest.TextTestRunner(
            stream=io.StringIO(), resultclass=partial(
                OfflineResult, destination=output_directory(),
            ),
        ).run(unittest.TestSuite([ExpectedFailure()]))
        self.assertFalse(successful(result))
        self.assertEqual(result.records[0]['status'], 'failed')

    def test_attachment_error_does_not_hide_the_original_failure(self):
        class DeliberateFailure(unittest.TestCase):
            def runTest(self):
                FrameReplay([load_fixture('global_startup_promo_20261108')], ReplayClock())
                self.fail('original assertion')

        with patch('develop_tools.run_offline_tests.shutil.copyfile', side_effect=OSError('controlled write error')):
            result = unittest.TextTestRunner(
                stream=io.StringIO(), resultclass=partial(OfflineResult, destination=output_directory()),
            ).run(unittest.TestSuite([DeliberateFailure()]))
        details = '\n'.join(result.records[0]['details'])
        self.assertIn('original assertion', details)
        self.assertIn('controlled write error', details)
        self.assertFalse(successful(result))

    def test_entry_reports_preparation_errors_without_skipping(self):
        for error in (FileNotFoundError('missing sample'), ValueError('corrupted sample')):
            destination = ROOT / 'develop_tools/out/offline-tests' / f'negative-{uuid4().hex[:8]}'
            with self.subTest(error=str(error)), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), \
                    patch('develop_tools.run_offline_tests.validate_fixtures', side_effect=error):
                self.assertEqual(main(['--suite', 'popups', '--out', str(destination)]), 2)
            report = json.loads((destination / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(report['status'], 'preparation_error')
            self.assertEqual(report['error'], str(error))
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(main(['--case', 'not-registered']), 2)

    def test_entry_rejects_failed_and_skipped_runs(self):
        class DeliberateFailure(unittest.TestCase):
            def runTest(self):
                self.fail('controlled failure')

        class Skipped(unittest.TestCase):
            def runTest(self):
                self.skipTest('controlled skip')

        for case, expected in ((DeliberateFailure(), 'failed'), (Skipped(), 'skipped')):
            destination = ROOT / 'develop_tools/out/offline-tests' / f'negative-{uuid4().hex[:8]}'
            with self.subTest(status=expected), \
                    redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), \
                    patch('develop_tools.run_offline_tests.select_cases', return_value=[case]):
                self.assertEqual(main(['--out', str(destination)]), 1)
            report = json.loads((destination / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(report['counts'][expected], 1)

    def test_existing_report_directory_is_not_overwritten(self):
        destination = output_directory()
        marker = destination / 'preserved.txt'
        marker.write_text('keep', encoding='utf-8')
        with self.assertRaises(FileExistsError):
            output_directory(destination)
        self.assertEqual(marker.read_text(encoding='utf-8'), 'keep')

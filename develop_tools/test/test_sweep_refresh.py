"""Offline regressions for daily refresh of optional sweep lists."""

from copy import deepcopy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from core.Baas_thread import Baas_thread
from core.config.config_set import ConfigSet
from core.config.default_config import STATIC_DEFAULT_CONFIG
from core.config.generated_static_config import StaticConfig


class SweepRefreshTests(unittest.TestCase):
    def setUp(self):
        static = StaticConfig(**json.loads(STATIC_DEFAULT_CONFIG))
        static_patch = patch.object(ConfigSet, 'static_config', static)
        static_patch.start()
        self.addCleanup(static_patch.stop)

    def worker(self, value):
        worker = object.__new__(Baas_thread)
        worker.config = SimpleNamespace(
            mainlinePriority=deepcopy(value), hardPriority=deepcopy(value),
            unfinished_normal_tasks=[(5, 1, 9)], unfinished_hard_tasks=[(5, 1, 3)],
        )
        worker.config_set = Mock()
        worker.logger = Mock()
        return worker

    def assert_refresh(self, value, expected, error_count=0):
        for method, source, target in (
            ('refresh_common_tasks', 'mainlinePriority', 'unfinished_normal_tasks'),
            ('refresh_hard_tasks', 'hardPriority', 'unfinished_hard_tasks'),
        ):
            with self.subTest(method=method, value=value):
                worker = self.worker(value)
                getattr(worker, method)()
                self.assertEqual(getattr(worker.config, target), expected)
                self.assertEqual(getattr(worker.config, source), value)
                worker.config_set.set.assert_called_once_with(target, expected)
                self.assertEqual(worker.logger.error.call_count, error_count)

    def test_empty_settings_clear_stale_tasks_without_logging_errors(self):
        for value in ('', ' \t\n', [], ['', ' \t'], ', ,\t,'):
            self.assert_refresh(value, [])

    def test_valid_tasks_keep_order_and_maximum_count(self):
        self.assert_refresh('1-1-3,2-2-max', [(1, 1, 3), (2, 2, 'max')])

    def test_empty_entries_and_outer_whitespace_do_not_drop_valid_tasks(self):
        self.assert_refresh(' , 1-1-3, , 2-2-max, ', [(1, 1, 3), (2, 2, 'max')])
        self.assert_refresh(['', ' 1-1-3 ', ' \t', '2-2-max'], [(1, 1, 3), (2, 2, 'max')])

    def test_nonempty_format_errors_are_still_reported_and_valid_tasks_continue(self):
        self.assert_refresh('1-1-3,wrong,2-2-max', [(1, 1, 3), (2, 2, 'max')], error_count=1)

    def test_malformed_non_string_entries_are_not_silently_ignored(self):
        self.assert_refresh([None, '1-1-3'], [(1, 1, 3)], error_count=1)

    def test_daily_refresh_with_empty_normal_list_still_refreshes_hard_tasks(self):
        worker = self.worker('')
        worker.server = 'Global'
        worker.config.last_refresh_config_time = 0
        worker.config.alreadyCreateTime = 2
        worker.config.hardPriority = '2-2-3'
        worker.daily_config_refresh()
        self.assertEqual(worker.config.unfinished_normal_tasks, [])
        self.assertEqual(worker.config.unfinished_hard_tasks, [(2, 2, 3)])
        self.assertEqual(worker.config.alreadyCreateTime, 0)
        worker.config_set.set.assert_any_call('unfinished_normal_tasks', [])
        worker.config_set.set.assert_any_call('unfinished_hard_tasks', [(2, 2, 3)])
        worker.logger.error.assert_not_called()
        worker.logger.info.assert_called_once_with('daily config refreshed')


if __name__ == '__main__':
    unittest.main()

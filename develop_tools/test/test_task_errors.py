"""Task failures stay in logs; user stops do not become recovery errors."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from core.Baas_thread import Baas_thread
from core.exception import FunctionCallTimeout, PackageIncorrect, RequestHumanTakeOver


class TaskErrorTests(unittest.TestCase):
    def worker(self):
        worker = object.__new__(Baas_thread)
        worker.flag_run = True
        worker.logger = Mock()
        worker.button_signal = Mock()
        worker.package_name = 'test.game'
        worker.connection = Mock()
        worker.connection.get_current_package.return_value = worker.package_name
        worker.config = SimpleNamespace(push_after_error=False, push_after_completion=False)
        return worker

    def test_stopped_task_is_not_executed(self):
        worker = self.worker()
        worker.flag_run = False
        task = Mock()
        with patch.dict('core.Baas_thread.func_dict', {'test-task': task}):
            self.assertTrue(worker.solve('test-task'))
        task.assert_not_called()

    def test_stop_before_exception_does_not_start_recovery_or_report_error(self):
        for exception in (PackageIncorrect('other.app'), FunctionCallTimeout(),
                          RequestHumanTakeOver(), RuntimeError('stopped')):
            with self.subTest(exception=type(exception).__name__):
                worker = self.worker()
                worker.push_and_log_error_msg = Mock()
                worker.deal_with_package_incorrect = Mock()
                worker.deal_with_func_call_timeout = Mock()

                def stopped(_worker, error=exception):
                    _worker.signal_stop()
                    raise error

                with patch.dict('core.Baas_thread.func_dict', {'test-task': Mock(side_effect=stopped)}):
                    self.assertTrue(worker.solve('test-task'))
                worker.push_and_log_error_msg.assert_not_called()
                worker.deal_with_package_incorrect.assert_not_called()
                worker.deal_with_func_call_timeout.assert_not_called()

    def test_stop_during_real_recovery_does_not_report_restart_failure(self):
        for exception in (PackageIncorrect('other.app'), FunctionCallTimeout()):
            with self.subTest(exception=type(exception).__name__):
                worker = self.worker()
                worker.push_and_log_error_msg = Mock()

                def stop_restarting(_worker):
                    _worker.signal_stop()
                    raise RequestHumanTakeOver()

                task = Mock(side_effect=exception)
                restart = Mock(side_effect=stop_restarting)
                with patch.dict('core.Baas_thread.func_dict', {'test-task': task, 'restart': restart}):
                    self.assertTrue(worker.solve('test-task'))
                task.assert_called_once_with(worker)
                restart.assert_called_once_with(worker)
                worker.push_and_log_error_msg.assert_not_called()

    def test_real_package_recovery_failure_still_stops_and_logs_error(self):
        worker = self.worker()
        worker.deal_with_package_incorrect = Mock(return_value=False)
        with patch.dict('core.Baas_thread.func_dict', {'test-task': Mock(side_effect=PackageIncorrect())}), \
                patch('core.Baas_thread.push') as remote_push, patch('core.exception.traceback.print_exc'):
            self.assertFalse(worker.solve('test-task'))
        self.assertFalse(worker.flag_run)
        worker.logger.error.assert_any_call('Package Incorrect')
        worker.logger.error.assert_any_call('All activities stopped. Require human take over.')
        remote_push.assert_called_once_with(worker.logger, worker.config, 'Package Incorrect')

    def test_scheduler_errors_only_log_without_local_notification(self):
        for relaunch in (False, True):
            with self.subTest(relaunch=relaunch):
                worker = self.worker()
                worker.last_refresh_u2_time = float('inf')
                worker.daily_config_refresh = Mock()
                worker.genScheduleLog = Mock()
                worker.scheduler = Mock()

                def next_task(current=worker, closed=relaunch):
                    current._game_closed = closed
                    return {'pre_task': [], 'current_task': 'test-task', 'post_task': []}

                worker.scheduler.heartbeat.side_effect = next_task
                failing = Mock(side_effect=RequestHumanTakeOver('needs attention'))
                with patch.dict('core.Baas_thread.func_dict', {'test-task': failing, 'restart': failing}), \
                        patch('core.Baas_thread.push'), patch('core.exception.traceback.print_exc'), \
                        patch('core.notification._notify') as notification, \
                        patch('core.notification._toast') as interactive_notification:
                    worker.thread_starter()
                self.assertFalse(worker.flag_run)
                worker.logger.error.assert_any_call('All activities stopped. Require human take over.')
                notification.assert_not_called()
                interactive_notification.assert_not_called()
                failing.assert_called_once_with(worker)


if __name__ == '__main__':
    unittest.main()

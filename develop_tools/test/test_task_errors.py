"""Task failures stay in logs; user stops do not become recovery errors."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from core.Baas_thread import SINGLE_RUN_COMPLETION_TASKS, Baas_thread
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


class TaskCompletionTests(unittest.TestCase):
    def worker(self):
        worker = TaskErrorTests().worker()
        worker.config = SimpleNamespace(name='离线账号', push_after_error=True, push_after_completion=True,
                                        push_onepush=[{'provider': 'system', 'enabled': True, 'params': {}}])
        return worker

    def test_completion_covers_exactly_the_two_settings_groups(self):
        from server.panels import PANELS
        tasks = {action['task'] for panel in PANELS if panel['id'] in ('proceedPlot', 'eventMap')
                 for group in panel['groups'] for field in group['fields']
                 for action in field.get('actions', [])}
        self.assertEqual(set(SINGLE_RUN_COMPLETION_TASKS), tasks)

    def test_each_successful_one_shot_sends_one_named_completion(self):
        for task, label in SINGLE_RUN_COMPLETION_TASKS.items():
            with self.subTest(task=task):
                worker = self.worker()
                action = Mock(return_value=True)
                with patch.dict('core.Baas_thread.func_dict', {task: action}), \
                        patch('core.notification._notify') as native, patch('requests.Session.request') as request:
                    self.assertTrue(worker.send('solve', task))
                action.assert_called_once_with(worker)
                native.assert_called_once()
                self.assertEqual(native.call_args.kwargs['title'], 'YAB 任务完成')
                self.assertEqual(native.call_args.kwargs['body'], f'离线账号：{label}已执行完成。')
                request.assert_not_called()

    def test_false_or_missing_result_never_sends_completion(self):
        for result in (False, None):
            with self.subTest(result=result):
                worker = self.worker()
                with patch.dict('core.Baas_thread.func_dict', {'main_story': Mock(return_value=result)}), \
                        patch('core.notification._notify') as native:
                    self.assertEqual(worker.send('solve', 'main_story'), result)
                native.assert_not_called()

    def test_stop_before_or_during_task_never_sends_completion(self):
        for before in (True, False):
            with self.subTest(before=before):
                worker = self.worker()
                worker.flag_run = not before

                def stop(current):
                    current.send('stop')
                    return True

                action = Mock(side_effect=stop)
                with patch.dict('core.Baas_thread.func_dict', {'main_story': action}), \
                        patch('core.notification._notify') as native:
                    self.assertTrue(worker.send('solve', 'main_story'))
                self.assertEqual(action.call_count, 0 if before else 1)
                native.assert_not_called()

    def test_task_error_only_sends_the_existing_error_notification(self):
        worker = self.worker()
        with patch.dict('core.Baas_thread.func_dict', {'main_story': Mock(side_effect=RuntimeError('offline'))}), \
                patch('core.notification._notify') as native, patch('core.exception.traceback.print_exc'):
            self.assertFalse(worker.send('solve', 'main_story'))
        self.assertFalse(worker.flag_run)
        native.assert_called_once()
        self.assertEqual(native.call_args.kwargs['title'], 'YAB Error')

    def test_disabled_completion_and_scheduled_subtasks_do_not_notify(self):
        worker = self.worker()
        with patch.dict('core.Baas_thread.func_dict', {'main_story': Mock(return_value=True)}), \
                patch('core.notification._notify') as native:
            worker.config.push_after_completion = False
            self.assertTrue(worker.send('solve', 'main_story'))
            worker.config.push_after_completion = True
            self.assertTrue(worker.solve('main_story'))
        native.assert_not_called()

    def test_notification_failure_does_not_change_task_success(self):
        worker = self.worker()
        with patch.dict('core.Baas_thread.func_dict', {'main_story': Mock(return_value=True)}), \
                patch('core.notification._notify', side_effect=RuntimeError('offline failure')):
            self.assertTrue(worker.send('solve', 'main_story'))


if __name__ == '__main__':
    unittest.main()

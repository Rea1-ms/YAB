"""Offline regressions for worker ownership, startup, paths, and gestures."""

import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from server.service import BaasService, config_path


class ScratchTest(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[2]
        output = root / 'develop_tools' / 'out'
        output.mkdir(parents=True, exist_ok=True)
        self.scratch = Path(tempfile.mkdtemp(prefix='webui-regression-', dir=output))
        previous = Path.cwd()
        os.chdir(self.scratch)
        self.addCleanup(os.chdir, previous)


class FakeHub:
    def __init__(self):
        self.messages = []
        self.meta_changed = threading.Event()

    def push(self, topic, op, value):
        self.messages.append((topic, op, value))
        if topic == 'Meta':
            self.meta_changed.set()

    def push_full(self, topic):
        pass

    def log(self, *args):
        pass


class FakeTask:
    def __init__(self, service, config, block_init=False):
        self.service = service
        self.config = config
        self.commands = []
        self.initializing = threading.Event()
        self.executing = threading.Event()
        self.release = threading.Event()
        self.block_init = block_init

    def init_all_data(self):
        self.initializing.set()
        if self.block_init:
            self.release.wait(5)
        return True

    def send(self, command, *args):
        self.commands.append(command)
        if command == 'stop':
            self.service._on_button(self.config, '启动')
        else:
            self.executing.set()
            self.release.wait(5)


class WorkerTests(ScratchTest):
    def setUp(self):
        super().setUp()
        for name in ('account', 'default_config'):
            folder = self.scratch / 'config' / name
            folder.mkdir(parents=True)
            (folder / 'config.json').write_text('{}', encoding='utf-8')
        self.service = BaasService(FakeHub())
        self.service.ocr_ready = True

    def task(self, block_init=False):
        task = FakeTask(self.service, 'account', block_init)
        self.service._create_thread = Mock(return_value=task)

        def finish():
            task.release.set()
            for worker in self.service.workers.values():
                worker.join(2)
        self.addCleanup(finish)
        return task

    def test_single_task_cannot_replace_active_scheduler(self):
        task = self.task()
        self.service.start('account')
        self.assertTrue(task.executing.wait(2))
        with self.assertRaises(ValueError):
            self.service.run_task('account', 'mail')
        self.assertIs(self.service.threads['account'], task)
        self.service.stop('account')
        self.assertIn('stop', task.commands)
        self.assertTrue(self.service.get_state('account')['running'])
        self.service.start('account')
        self.service._create_thread.assert_called_once()

    def test_single_task_reports_running_and_clears_on_finish(self):
        task = self.task()
        self.service.run_task('account', 'mail')
        self.assertTrue(task.executing.wait(2))
        self.assertTrue(self.service.get_state('account')['running'])
        with self.assertRaises(ValueError):
            self.service.run_task('account', 'mail')
        task.release.set()
        self.service.workers['account'].join(2)
        self.assertFalse(self.service.get_state('account')['running'])
        self.assertNotIn('account', self.service.threads)

    def test_stop_during_initialization_prevents_execution(self):
        task = self.task(block_init=True)
        self.service.start('account')
        self.assertTrue(task.initializing.wait(2))
        self.service.stop('account')
        task.release.set()
        self.service.workers['account'].join(2)
        self.assertNotIn('start', task.commands)
        self.assertNotIn('solve', task.commands)
        self.assertFalse(self.service.get_state('account')['running'])

    def test_parallel_requests_create_only_one_worker(self):
        task = self.task()
        barrier = threading.Barrier(3)
        errors = []

        def launch():
            barrier.wait(2)
            try:
                self.service.run_task('account', 'mail')
            except ValueError as error:
                errors.append(error)

        callers = [threading.Thread(target=launch) for _ in range(2)]
        for caller in callers:
            caller.start()
        barrier.wait(2)
        for caller in callers:
            caller.join(2)
        self.assertTrue(task.executing.wait(2))
        self.service._create_thread.assert_called_once()
        self.assertEqual(len(errors), 1)

    def test_aliases_and_parent_paths_never_reach_deletion(self):
        with patch('server.service.shutil.rmtree') as delete:
            for name in ('default_config', './default_config', '../config/default_config',
                         '..\\config\\default_config', '.', '..', 'account.', 'account '):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    self.service.config_delete(name)
            delete.assert_not_called()
        self.assertTrue((self.scratch / 'config/default_config/config.json').is_file())

    def test_running_worker_cannot_be_deleted_even_after_stop_request(self):
        task = self.task()
        self.service.start('account')
        self.assertTrue(task.executing.wait(2))
        self.service.stop('account')
        with patch('server.service.shutil.rmtree') as delete, self.assertRaises(ValueError):
            self.service.config_delete('account')
        delete.assert_not_called()

    def test_all_config_entrypoints_reject_paths(self):
        for call in (lambda: self.service.get_state('../account'),
                     lambda: self.service.provide_config_arg('../account'),
                     lambda: self.service.config_set('../account', {'key': 'name', 'value': ''}),
                     lambda: self.service.provide_event_config('../account')):
            with self.assertRaises(ValueError):
                call()
        self.assertEqual(config_path('account'), self.scratch / 'config/account')


class OcrTests(unittest.TestCase):
    def test_core_failure_does_not_become_ready_or_autostart(self):
        import main
        with patch.object(main.Main, 'init_ocr', return_value=False):
            core = main.Main(ocr_needed=['en-us'])
        self.assertFalse(core.ready)
        hub = FakeHub()
        service = BaasService(hub)
        service._autostart = Mock()
        with patch.object(main, 'Main', return_value=core):
            service.init_ocr(['en-us'])
            self.assertTrue(hub.meta_changed.wait(2))
        self.assertFalse(service.ocr_ready)
        self.assertTrue(service.ocr_error)
        service._autostart.assert_not_called()

    def test_client_object_left_after_failure_is_not_sufficient(self):
        hub = FakeHub()
        service = BaasService(hub)
        core = SimpleNamespace(ready=False, init_error='识别服务启动失败', ocr=object())
        with patch('main.Main', return_value=core):
            service.init_ocr(['en-us'])
            self.assertTrue(hub.meta_changed.wait(2))
        self.assertFalse(service.ocr_ready)
        self.assertEqual(service.ocr_error, '识别服务启动失败')


class GestureTests(unittest.TestCase):
    def control(self):
        from core.device.control.maatouch import MaaTouchControl
        control = MaaTouchControl.__new__(MaaTouchControl)
        control._lock = threading.Lock()
        control._sock = Mock()
        control._screen_size = (1280, 720)
        control.max_x, control.max_y = 1280, 720
        return control

    def test_long_click_waits_before_returning(self):
        control = self.control()
        started = time.monotonic()
        control.long_click(200, 200, .2)
        self.assertGreaterEqual(time.monotonic() - started, .2)
        self.assertIn(b'w 200\n', control._sock.sendall.call_args.args[0])

    def test_swipe_wait_covers_all_device_waits_and_holds_lock(self):
        import re
        control = self.control()
        waits = []

        def sleep(duration):
            self.assertTrue(control._lock.locked())
            waits.append(duration)

        with patch('core.device.control.maatouch.time.sleep', side_effect=sleep):
            control.swipe(0, 0, 100, 100, .3)
        content = control._sock.sendall.call_args.args[0]
        device_wait = sum(int(ms) for ms in re.findall(rb'w (\d+)\n', content)) / 1000
        self.assertGreaterEqual(sum(waits), device_wait)


if __name__ == '__main__':
    unittest.main()

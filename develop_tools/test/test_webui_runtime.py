"""Offline regressions for worker ownership, startup, paths, and gestures."""

import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from server import frontend
from server.service import BaasService, config_path, scan_configs


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


class ConfigNameTests(ScratchTest):
    def setUp(self):
        super().setUp()
        from core.config.config_set import ConfigSet
        from core.config.default_config import STATIC_DEFAULT_CONFIG
        from core.config.generated_static_config import StaticConfig
        static = StaticConfig(**json.loads(STATIC_DEFAULT_CONFIG))
        static_patch = patch.object(ConfigSet, 'static_config', static)
        static_patch.start()
        self.addCleanup(static_patch.stop)
        self.hub = FakeHub()
        self.hub.push_full = Mock()
        self.service = BaasService(self.hub)

    def test_new_config_uses_requested_display_name(self):
        self.service.config_add('设备一')
        self.assertEqual(scan_configs(), [{'dir': '设备一', 'name': '设备一'}])
        self.assertEqual(self.service.provide_config_arg('设备一')['name'], '设备一')

    def test_rename_refreshes_both_views_and_preserves_directory_and_values(self):
        self.service.config_add('account')
        before = self.service.provide_config_arg('account')
        self.hub.push_full.reset_mock()
        self.service.config_rename('account', '  主账号  ')
        self.assertEqual(scan_configs(), [{'dir': 'account', 'name': '主账号'}])
        self.assertEqual(self.service.provide_config_arg('account'),
                         {**before, 'name': '主账号'})
        self.assertEqual([call.args[0] for call in self.hub.push_full.call_args_list],
                         ['ConfigScan', 'ConfigArg:account'])
        self.assertTrue((self.scratch / 'config/account/config.json').is_file())
        self.assertFalse((self.scratch / 'config/主账号').exists())

    def test_name_edit_in_advanced_config_also_refreshes_list(self):
        self.service.config_add('account')
        self.hub.push_full.reset_mock()
        self.service.config_set('account', {'key': 'name', 'value': '  备用账号  '})
        self.assertEqual(scan_configs(), [{'dir': 'account', 'name': '备用账号'}])
        self.assertEqual(self.service.provide_config_arg('account')['name'], '备用账号')
        self.assertEqual([call.args[0] for call in self.hub.push_full.call_args_list],
                         ['ConfigScan', 'ConfigArg:account'])

    def test_invalid_names_are_rejected_by_both_edit_paths(self):
        self.service.config_add('account')
        before = self.service.provide_config_arg('account')
        self.hub.push_full.reset_mock()
        for value in ('', '  ', None, 42):
            for entrypoint in ('rename', 'set'):
                with self.subTest(value=value, entrypoint=entrypoint):
                    with self.assertRaises(ValueError):
                        if entrypoint == 'rename':
                            self.service.config_rename('account', value)
                        else:
                            self.service.config_set('account', {'key': 'name', 'value': value})
                    self.assertEqual(self.service.provide_config_arg('account'), before)
        self.hub.push_full.assert_not_called()


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


class FrontendTests(ScratchTest):
    def source(self):
        webapp = self.scratch / 'webapp'
        webapp.mkdir()
        (webapp / 'package.json').write_text('{}', encoding='utf-8')
        return webapp

    def test_missing_assets_are_built_and_existing_files_are_retained(self):
        webapp = self.source()

        def build(command, **kwargs):
            if 'build' in command:
                self.assertIn('false', command)
                (webapp / 'dist').mkdir(exist_ok=True)
                (webapp / 'dist/index.html').write_text('网页', encoding='utf-8')

        with patch.object(frontend.shutil, 'which', return_value='tool'), \
                patch.object(frontend.subprocess, 'check_output', return_value='v22.23.4'), \
                patch.object(frontend.subprocess, 'run', side_effect=build) as run:
            frontend.ensure_frontend(self.scratch)
            self.assertTrue((webapp / 'dist/index.html').is_file())
            self.assertEqual(run.call_count, 2)
            frontend.ensure_frontend(self.scratch)
            self.assertEqual(run.call_count, 2)
            source = webapp / 'src/main.ts'
            source.parent.mkdir()
            source.write_text('// source changed', encoding='utf-8')
            newer = (webapp / 'dist/index.html').stat().st_mtime + 2
            os.utime(source, (newer, newer))
            frontend.ensure_frontend(self.scratch)
            self.assertEqual(run.call_count, 4)

    def test_missing_tools_report_setup_requirements_before_installing(self):
        self.source()
        for missing in ('node', 'pnpm'):
            with self.subTest(missing=missing), \
                    patch.object(frontend.shutil, 'which', side_effect=lambda name: None if name == missing else name), \
                    patch.object(frontend.subprocess, 'check_output', return_value='v24.22.1'), \
                    patch.object(frontend.subprocess, 'run') as run, \
                    self.assertRaisesRegex(RuntimeError, 'Node.js' if missing == 'node' else 'pnpm'):
                frontend.ensure_frontend(self.scratch)
            run.assert_not_called()

    def test_incompatible_installed_node_reports_requirement_before_installing(self):
        self.source()
        for version in ('v18.20.8', 'v20.18.0', 'v22.11.0', 'v23.11.0'):
            with self.subTest(version=version), \
                    patch.object(frontend.shutil, 'which', return_value='tool'), \
                    patch.object(frontend.subprocess, 'check_output', return_value=version), \
                    patch.object(frontend.subprocess, 'run') as run, \
                    self.assertRaisesRegex(RuntimeError, '不支持 Vite 8'):
                frontend.ensure_frontend(self.scratch)
            run.assert_not_called()

    def test_existing_package_manager_is_used_without_version_pinning(self):
        webapp = self.source()

        def build(command, **kwargs):
            if 'build' in command:
                (webapp / 'dist').mkdir()
                (webapp / 'dist/index.html').write_text('网页', encoding='utf-8')

        with patch.object(frontend.shutil, 'which', side_effect=lambda name, **kwargs: name), \
                patch.object(frontend.subprocess, 'check_output', return_value='v24.22.1') as version, \
                patch.object(frontend.subprocess, 'run', side_effect=build) as run:
            frontend.ensure_frontend(self.scratch)
        version.assert_called_once_with(['node', '--version'], text=True)
        self.assertEqual(run.call_args_list[0].args[0], ['pnpm', 'install', '--frozen-lockfile'])
        self.assertEqual(run.call_args_list[1].args[0], ['pnpm', 'run', 'build', '--emptyOutDir', 'false'])
        self.assertNotIn('env', run.call_args.kwargs)

    def test_existing_built_assets_do_not_require_frontend_tools(self):
        webapp = self.source()
        (webapp / 'dist').mkdir()
        (webapp / 'dist/index.html').write_text('网页', encoding='utf-8')
        with patch.object(frontend.shutil, 'which', return_value=None) as which, \
                patch.object(frontend.subprocess, 'run') as run:
            frontend.ensure_frontend(self.scratch)
        which.assert_not_called()
        run.assert_not_called()

    def test_incomplete_packaged_app_fails_instead_of_serving_404(self):
        self.source()
        with patch.object(frontend.sys, 'frozen', True, create=True), self.assertRaises(RuntimeError):
            frontend.ensure_frontend(self.scratch)

    def test_source_distribution_uses_built_assets_without_developer_tools(self):
        webapp = self.source()
        (self.scratch / 'distribution.json').write_text('{"version":"1.4.3"}', encoding='utf-8')
        (webapp / 'dist').mkdir()
        (webapp / 'dist/index.html').write_text('网页', encoding='utf-8')
        newer = (webapp / 'dist/index.html').stat().st_mtime + 2
        os.utime(webapp / 'package.json', (newer, newer))
        with patch.object(frontend.shutil, 'which') as which, patch.object(frontend.subprocess, 'run') as run:
            frontend.ensure_frontend(self.scratch)
        which.assert_not_called()
        run.assert_not_called()

    def test_incomplete_source_distribution_never_installs_frontend_dependencies(self):
        self.source()
        (self.scratch / 'distribution.json').write_text('{}', encoding='utf-8')
        with patch.object(frontend.subprocess, 'run') as run, self.assertRaisesRegex(RuntimeError, '发行包缺少'):
            frontend.ensure_frontend(self.scratch)
        run.assert_not_called()


class DistributionTests(ScratchTest):
    def test_ocr_initializes_an_existing_empty_config_directory(self):
        from core.ocr.baas_ocr_client.Client import BaasOcrClient, ServerConfig
        ocr = self.scratch / 'ocr'
        (ocr / 'config').mkdir(parents=True)
        (ocr / 'resource').mkdir()
        defaults = {'ocr': {'server': {'host': '127.0.0.1', 'port': 8000}}}
        (ocr / 'resource/global_setting.json').write_text(json.dumps(defaults), encoding='utf-8')
        with patch.object(BaasOcrClient, 'server_folder_path', str(ocr)):
            config = ServerConfig()
        self.assertEqual(config.config, defaults)
        self.assertEqual(json.loads((ocr / 'config/global_setting.json').read_text()), defaults)

    @unittest.skipUnless(os.name == 'nt', 'Windows directory junction regression')
    def test_desktop_config_junctions_allow_first_start_and_preserve_settings(self):
        import _winapi
        from core.config.config_init import check_config
        from core.config.config_set import ConfigSet
        from core.ocr.baas_ocr_client.Client import BaasOcrClient, ServerConfig

        # Match the desktop layout: both mutable directories are shared junctions.
        shared = self.scratch / 'backend'
        version = self.scratch / 'versions' / 'test-version'
        ocr_relative = Path('core/ocr/baas_ocr_client/bin')
        ocr = version / ocr_relative
        ocr.mkdir(parents=True)
        for relative in (Path('config'), ocr_relative / 'config'):
            target = shared / relative
            target.mkdir(parents=True)
            _winapi.CreateJunction(str(target), str(version / relative))
        (ocr / 'resource').mkdir()
        defaults = {'ocr': {'server': {'host': '127.0.0.1', 'port': 8000}}}
        (ocr / 'resource/global_setting.json').write_text(json.dumps(defaults), encoding='utf-8')

        os.chdir(version)
        with patch.object(ConfigSet, 'static_config', None), \
                patch.object(BaasOcrClient, 'server_folder_path', str(ocr)):
            check_config(['default_config'])
            ConfigSet('default_config').set('name', '保留我的配置')
            config = ServerConfig()
            self.assertEqual(config.config, defaults)
            config.config['ocr']['server']['port'] = 9000
            config.save()
            check_config(['default_config'])
            self.assertEqual(ServerConfig().port, 9000)
            self.assertEqual(ConfigSet('default_config').get('name'), '保留我的配置')
        self.assertEqual(json.loads((shared / ocr_relative / 'config/global_setting.json').read_text())
                         ['ocr']['server']['port'], 9000)


class CliTests(unittest.TestCase):
    def test_api_only_skips_frontend_build(self):
        from server.__main__ import main
        with patch('sys.argv', ['server', '--api-only']), \
                patch.dict(os.environ, {'BAAS_WEBUI_TOKEN': ''}), \
                patch('server.__main__.ensure_frontend') as build, \
                patch('server.__main__.create_app') as app, \
                patch('server.__main__.uvicorn.run'):
            main()
        build.assert_not_called()
        app.assert_called_once_with(serve_webapp=False, listener={'host': '127.0.0.1', 'port': 22267})

    def test_remote_binding_requires_environment_password(self):
        from server.__main__ import main
        with patch('sys.argv', ['server', '--host', '0.0.0.0']), \
                patch.dict(os.environ, {'BAAS_WEBUI_TOKEN': ''}), \
                self.assertRaises(SystemExit) as error:
            main()
        self.assertEqual(error.exception.code, 2)

    def test_remote_binding_with_password_can_start(self):
        from server.__main__ import main
        with patch('sys.argv', ['server', '--host', '0.0.0.0']), \
                patch.dict(os.environ, {'BAAS_WEBUI_TOKEN': secrets.token_urlsafe(16)}), \
                patch('server.__main__.ensure_frontend') as build, \
                patch('server.__main__.create_app'), \
                patch('server.__main__.uvicorn.run') as run:
            main()
        build.assert_called_once()
        run.assert_called_once()


if __name__ == '__main__':
    unittest.main()

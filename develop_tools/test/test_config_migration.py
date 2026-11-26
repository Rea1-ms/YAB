"""Regressions for upgrading, saving, and protecting profile files."""

import json
import os
import unittest
from unittest.mock import Mock, patch

from core.Baas_thread import Baas_thread
from core.config.config_init import check_config
from core.config.config_io import PROFILE_SCHEMA_VERSION, ConfigFileError
from core.config.config_set import ConfigSet
from core.scheduler import Scheduler
from develop_tools.test_output import new_test_directory
from server.app import bootstrap_configs
from server.service import BaasService


class ConfigMigrationTests(unittest.TestCase):
    def setUp(self):
        root = new_test_directory(self, 'config-migration-')
        environment = patch.dict(os.environ, {'YAB_CONFIG_DIR': str(root)})
        environment.start()
        self.addCleanup(environment.stop)
        static = patch.object(ConfigSet, 'static_config', None)
        static.start()
        self.addCleanup(static.stop)
        self.folder = root / 'profiles/account'
        self.folder.mkdir(parents=True)
        self.main = self.folder / 'config.json'
        self.events = self.folder / 'event.json'
        self.backups = self.folder / 'backups'

    def test_new_web_profile_can_initialize_and_save_manufacturing_priorities(self):
        service = BaasService(Mock())
        service.config_add('new_account')
        config = ConfigSet('new_account')
        defaults = config.static_config.create_default_priority[config.server_mode]
        worker = Baas_thread.__new__(Baas_thread)
        worker.config_set = config
        worker.static_config = config.static_config
        worker.logger = Mock()

        self.assertTrue(worker.init_config(), worker.logger.error.call_args_list)
        saved = service.provide_config_arg('new_account')
        for phase, priority in defaults.items():
            self.assertEqual(saved[f'createPriority_{phase}'], priority)

    def test_manufacturing_priority_migration_preserves_lists_and_normalizes_strings(self):
        for version in (0, PROFILE_SCHEMA_VERSION):
            with self.subTest(version=version):
                name = f'account_{version}'
                folder = self.folder.with_name(name)
                folder.mkdir()
                main = folder / 'config.json'
                data = {'createPriority_phase1': ['second', 'first'],
                        'createPriority_phase2': '', 'createPriority_phase3': 'one item'}
                if version:
                    data['schemaVersion'] = version
                raw = json.dumps(data).encode('utf-8')
                main.write_bytes(raw)

                check_config(name)

                saved = json.loads(main.read_bytes())
                self.assertEqual(saved['schemaVersion'], PROFILE_SCHEMA_VERSION)
                self.assertEqual(saved['createPriority_phase1'], ['second', 'first'])
                self.assertEqual(saved['createPriority_phase2'], [])
                self.assertEqual(saved['createPriority_phase3'], ['one item'])
                backups = (folder / 'backups').glob(f'config.v{version}.*.bak.json')
                self.assertEqual([file.read_bytes() for file in backups], [raw])

    def test_migration_backs_up_both_originals_only_when_changed(self):
        main_bytes = b'{"name":"legacy","unrecognized":{"value":4}}\n'
        event_bytes = b'[{"func_name":"restart","enabled":false,"future_option":7}]\n'
        self.main.write_bytes(main_bytes)
        self.events.write_bytes(event_bytes)

        check_config('account')
        data = json.loads(self.main.read_bytes())
        self.assertEqual(data['schemaVersion'], PROFILE_SCHEMA_VERSION)
        self.assertEqual(data['unrecognized'], {'value': 4})
        restart = next(event for event in json.loads(self.events.read_bytes()) if event['func_name'] == 'restart')
        self.assertEqual(restart['future_option'], 7)
        self.assertFalse(restart['enabled'])
        self.assertEqual([file.read_bytes() for file in self.backups.glob('config.v0.*.bak.json')], [main_bytes])
        self.assertEqual([file.read_bytes() for file in self.backups.glob('event.v0.*.bak.json')], [event_bytes])
        saved = self.main.read_bytes(), self.events.read_bytes()
        check_config('account')
        self.assertEqual((self.main.read_bytes(), self.events.read_bytes()), saved)
        self.assertEqual(len(list(self.backups.iterdir())), 2)

    def test_bad_schedule_leaves_both_originals_and_other_profile_usable(self):
        self.main.write_bytes(b'{"name":"main"}')
        self.events.write_bytes(b'broken schedule')
        check_config('other')
        service = BaasService(Mock())

        bootstrap_configs(service)
        profiles = {entry['dir']: entry for entry in service.provide_config_scan()}
        self.assertIn('无法读取配置文件', profiles['account']['error'])
        self.assertNotIn('error', profiles['other'])
        self.assertEqual(self.main.read_bytes(), b'{"name":"main"}')
        self.assertEqual(self.events.read_bytes(), b'broken schedule')
        with self.assertRaises(ConfigFileError):
            service.config_set('account', {'key': 'name', 'value': 'ignored'})

    def test_future_config_cannot_be_overwritten_by_an_existing_editor(self):
        check_config('account')
        config = ConfigSet('account')
        original_events = self.events.read_bytes()
        future = json.loads(self.main.read_bytes())
        future['schemaVersion'] = PROFILE_SCHEMA_VERSION + 1
        raw = json.dumps(future, ensure_ascii=False).encode('utf-8')
        self.main.write_bytes(raw)

        with self.assertRaisesRegex(ConfigFileError, '更新版本'):
            check_config('account')
        config.config.name = 'stale edit'
        with self.assertRaisesRegex(ConfigFileError, '更新版本'):
            config.save()
        service = BaasService(Mock())
        with self.assertRaisesRegex(ConfigFileError, '更新版本'):
            service.event_enable_all('account', {'enabled': False})
        self.assertEqual(self.main.read_bytes(), raw)
        self.assertEqual(self.events.read_bytes(), original_events)

    def test_concurrent_main_edits_preserve_latest_values_and_unknown_keys(self):
        self.main.write_text('{"extra":{"key":4},"ap":{"future_key":2}}', encoding='utf-8')
        check_config('account')
        task = ConfigSet('account')
        ConfigSet('account').set('name', '页面保存的名称')
        ConfigSet('account').set('ap', {'value': 5})
        task.config.create_item_holding_quantity['Keystone'] = 3
        task.save()

        data = json.loads(self.main.read_bytes())
        self.assertEqual(data['name'], '页面保存的名称')
        self.assertEqual(data['extra'], {'key': 4})
        self.assertEqual(data['ap']['future_key'], 2)
        self.assertEqual(data['ap']['value'], 5)
        self.assertEqual(data['create_item_holding_quantity']['Keystone'], 3)

    def test_retry_after_backup_failure_keeps_original_files(self):
        self.main.write_bytes(b'{"name":"legacy"}')
        self.events.write_bytes(b'[{"func_name":"restart"}]')
        originals = self.main.read_bytes(), self.events.read_bytes()
        with (patch('core.config.config_init.backup_migration', side_effect=OSError('backup failed')),
              self.assertRaisesRegex(OSError, 'backup failed')):
            check_config('account')
        self.assertEqual((self.main.read_bytes(), self.events.read_bytes()), originals)
        check_config('account')
        self.assertEqual(json.loads(self.main.read_bytes())['schemaVersion'], PROFILE_SCHEMA_VERSION)

    def test_scheduler_retains_web_edits_and_unknown_tasks(self):
        check_config('account')
        events = json.loads(self.events.read_bytes())
        future = {'func_name': 'future_task', 'future_option': 7}
        events.append(future)
        self.events.write_text(json.dumps(events, ensure_ascii=False), encoding='utf-8')
        scheduler = Scheduler(None, str(self.folder), supported_tasks={'restart'})
        self.assertEqual(scheduler.funcs, ['restart'])
        service = BaasService(Mock())
        service.event_set('account', {'func_name': 'restart', 'patch': {'enabled': False}})
        scheduler.systole('restart', next_time=60, force_task=True)

        saved = json.loads(self.events.read_bytes())
        restart = next(event for event in saved if event['func_name'] == 'restart')
        self.assertGreater(restart['next_tick'], 0)
        self.assertFalse(restart['enabled'])
        self.assertEqual(saved[-1], future)

    def test_scheduler_retains_a_manually_changed_execution_time(self):
        check_config('account')
        scheduler = Scheduler(None, str(self.folder), supported_tasks={'restart'})
        tick = 1_800_000_000
        service = BaasService(Mock())
        service.event_set('account', {'func_name': 'restart', 'patch': {'next_tick': tick}})
        edited = self.events.read_bytes()

        execution_time = scheduler.systole('restart', next_time=60, force_task=True)

        self.assertEqual(execution_time.timestamp(), tick)
        self.assertEqual(self.events.read_bytes(), edited)


if __name__ == '__main__':
    unittest.main()

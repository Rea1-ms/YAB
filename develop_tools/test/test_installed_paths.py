"""Installed code stays in place while configuration and output use explicit paths."""

import json
import os
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from core.config.config_init import check_config, check_event_config
from core.config.config_io import ConfigFileError
from core.config.config_set import ConfigSet
from core.paths import data_path, profiles_dir
from develop_tools.test_output import new_test_directory
from server.service import config_path, scan_configs


class InstalledPathsTests(unittest.TestCase):
    def setUp(self):
        self.scratch = new_test_directory(self, 'installed-paths-')
        self.app = self.scratch / 'app'
        self.app.mkdir()
        previous = Path.cwd()
        os.chdir(self.app)
        self.addCleanup(os.chdir, previous)
        self.config = self.scratch / 'settings'
        self.data = self.scratch / 'data'
        self.ocr = self.scratch / 'ocr-data'
        env = patch.dict(os.environ, {
            'YAB_CONFIG_DIR': str(self.config), 'YAB_DATA_DIR': str(self.data),
            'YAB_OCR_DATA_DIR': str(self.ocr),
        })
        env.start()
        self.addCleanup(env.stop)
        previous_static = ConfigSet.static_config
        ConfigSet.static_config = None
        self.addCleanup(setattr, ConfigSet, 'static_config', previous_static)

    def test_configuration_bootstrap_scan_edit_and_static_load_use_shared_directory(self):
        check_config(['default_config', 'account'])
        self.assertEqual(config_path('account'), self.config / 'profiles' / 'account')
        self.assertEqual([item['dir'] for item in scan_configs()], ['account', 'default_config'])
        config = ConfigSet('account')
        config.set('name', 'installed profile')
        self.assertEqual(ConfigSet('account').get('name'), 'installed profile')
        from main import Main
        main = Main.__new__(Main)
        main.logger = Mock()
        self.assertTrue(main.init_static_config())
        self.assertEqual(list(self.app.iterdir()), [])
        with self.assertRaises(ValueError):
            config_path('../outside', require_exists=False)

    def test_invalid_schedule_keeps_the_installed_profile_file(self):
        check_config('account')
        schedule = profiles_dir() / 'account' / 'event.json'
        schedule.write_bytes(b'invalid')
        with self.assertRaisesRegex(ConfigFileError, '无法读取配置文件'):
            check_event_config('account', ConfigSet('account'))
        self.assertEqual(schedule.read_bytes(), b'invalid')
        self.assertFalse(data_path('error.log').exists())
        self.assertEqual(list(self.app.iterdir()), [])

    def test_native_ocr_uses_installed_binary_and_separate_working_directory(self):
        from core.ocr.baas_ocr_client.Client import BaasOcrClient
        binary = self.app / 'ocr-bin'
        (binary / 'resource').mkdir(parents=True)
        (binary / 'BAAS_ocr_server.exe').write_bytes(b'test binary')
        defaults = {'ocr': {'server': {'host': '127.0.0.1', 'port': 1145}}}
        (binary / 'resource' / 'global_setting.json').write_text(json.dumps(defaults))
        with patch.object(BaasOcrClient, 'server_folder_path', str(binary)), \
                patch('core.ocr.baas_ocr_client.Client.subprocess.Popen') as spawn, \
                patch('core.ocr.baas_ocr_client.Client.requests.get', return_value=Mock(status_code=200)):
            client = BaasOcrClient()
            client.start_server()
        self.assertEqual(spawn.call_args.args[0], str(binary / 'BAAS_ocr_server.exe'))
        self.assertEqual(spawn.call_args.kwargs['cwd'], str(self.ocr))
        self.assertTrue((self.ocr / 'config' / 'global_setting.json').is_file())
        self.assertFalse((binary / 'config').exists())
        self.assertFalse((binary / 'output').exists())

    def test_source_launch_keeps_original_relative_paths(self):
        from core.ocr.baas_ocr_client.Client import BaasOcrClient
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(profiles_dir(), Path('config'))
            self.assertEqual(data_path('error.log'), Path('error.log'))
            self.assertEqual(BaasOcrClient.runtime_folder_path(), BaasOcrClient.server_folder_path)


if __name__ == '__main__':
    unittest.main()

"""Global web listener persistence and real HTTP/WebSocket protocol regressions."""

import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

import uvicorn
from websockets.sync.client import connect

from server.app import create_app
from server.webui_settings import DEFAULTS, load_settings, save_settings, settings_path, validate_settings


class WebSettingsTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).resolve().parents[2] / 'develop_tools/out'
        output.mkdir(exist_ok=True)
        self.scratch = Path(tempfile.mkdtemp(prefix='web-listener-', dir=output))
        env = patch.dict(os.environ, {'YAB_CONFIG_DIR': str(self.scratch), 'BAAS_WEBUI_TOKEN': '',
                                      'YAB_DESKTOP_PORT_OVERRIDE': ''})
        env.start()
        self.addCleanup(env.stop)

    def test_defaults_and_persistence_in_shared_configuration(self):
        self.assertEqual(load_settings(), DEFAULTS)
        settings = {'host': '127.0.0.1', 'port': 22345}
        save_settings(settings)
        self.assertEqual(settings_path(), self.scratch / 'webui.json')
        self.assertEqual(load_settings(), settings)
        self.assertEqual(json.loads(settings_path().read_text()), settings)

    def test_invalid_input_and_failed_write_preserve_saved_values(self):
        save_settings(DEFAULTS)
        for value in (None, [], {}, {'host': 1, 'port': 42}, {'host': 'invalid', 'port': 42},
                      {'host': '127.0.0.1', 'port': True}, {'host': '::1', 'port': '22267'},
                      {'host': '::1', 'port': 0}, {'host': '::1', 'port': 65536},
                      dict(DEFAULTS, token='must not be stored')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                save_settings(value)
            self.assertEqual(load_settings(), DEFAULTS)
        with patch.object(Path, 'replace', side_effect=PermissionError('occupied')):
            with self.assertRaises(PermissionError):
                save_settings({'host': '::1', 'port': 22345})
        self.assertEqual(load_settings(), DEFAULTS)
        settings_path().write_text('{broken', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'webui.json'):
            load_settings()

    def test_remote_listeners_require_password_and_never_persist_it(self):
        for host in ('localhost', '::1', '127.0.0.2'):
            save_settings({'host': host, 'port': 22267})
        for host in ('0.0.0.0', '::', '192.0.2.10'):
            with self.assertRaisesRegex(ValueError, 'BAAS_WEBUI_TOKEN'):
                save_settings({'host': host, 'port': 22267})
        token = secrets.token_urlsafe(32)
        with patch.dict(os.environ, {'BAAS_WEBUI_TOKEN': token}):
            save_settings({'host': '0.0.0.0', 'port': 22267})
        self.assertNotIn(token, settings_path().read_text())

    def test_source_cli_uses_saved_listener_and_explicit_overrides(self):
        from server.__main__ import main
        save_settings({'host': '127.0.0.1', 'port': 22345})
        for options, expected in (([], 22345), (['--port', '22346'], 22346)):
            with patch('sys.argv', ['server', '--api-only', *options]), \
                    patch('server.__main__.create_app') as app, \
                    patch('server.__main__.uvicorn.run') as run:
                main()
                self.assertEqual(run.call_args.kwargs['port'], expected)
                self.assertEqual(app.call_args.kwargs['listener']['port'], expected)

    def test_authenticated_http_and_websocket_save_without_changing_active_listener(self):
        token = secrets.token_urlsafe(32)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            saved = validate_settings({'host': '127.0.0.1', 'port': port})
            save_settings(saved)
            app = create_app(access_token=token, listener=saved)
            server = uvicorn.Server(uvicorn.Config(app, log_level='error'))
            thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
            with patch('server.app.bootstrap_configs'), patch('server.app.derive_ocr_needed', return_value=[]), \
                    patch('server.service.BaasService.init_ocr'), \
                    patch('server.app.build_meta', return_value={'ocr_ready': False}), \
                    patch('server.app.scan_configs', return_value=[]):
                thread.start()
                try:
                    deadline = time.monotonic() + 8
                    while not server.started and thread.is_alive() and time.monotonic() < deadline:
                        time.sleep(.02)
                    self.assertTrue(server.started)
                    base = f'http://127.0.0.1:{port}'
                    headers = {'Authorization': f'Bearer {token}'}
                    with urlopen(Request(base + '/api/health', headers=headers), timeout=3) as response:
                        self.assertEqual(json.load(response)['status'], 'ok')
                    with connect(f'ws://127.0.0.1:{port}/api/ws', origin=base,
                                 additional_headers=headers, open_timeout=3) as websocket:
                        def rpc(name, params, identity):
                            websocket.send(json.dumps({'t': 'Meta', 'o': 'rpc', 'f': name,
                                                       'v': params, 'i': identity}))
                            for _ in range(10):
                                result = json.loads(websocket.recv(timeout=3))
                                if result.get('i') == identity:
                                    return result
                            self.fail('RPC response missing')
                        self.assertEqual(rpc('webui_get', {}, 1)['r']['active'], saved)
                        new = {'host': '::1', 'port': 23456}
                        result = rpc('webui_save', new, 2)
                        self.assertIsNone(result['e'])
                        self.assertEqual(result['r']['saved'], new)
                        self.assertEqual(result['r']['active'], saved)
                        self.assertEqual(load_settings(), new)
                        result = rpc('webui_save', {'host': '::1', 'port': True}, 3)
                        self.assertTrue(result['e'])
                        self.assertEqual(load_settings(), new)
                finally:
                    server.should_exit = True
                    thread.join(8)
                self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()

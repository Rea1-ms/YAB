"""Notification migration and real OnePush adapters; all deliveries stay offline."""

import asyncio
import json
import logging
import os
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests

from core.config.config_init import check_and_update_user_config
from core.config.config_set import ConfigSet
from core.config.default_config import DEFAULT_CONFIG, STATIC_DEFAULT_CONFIG
from core.config.generated_static_config import StaticConfig
from core.push_config import legacy_channels, provider_catalog, validate_channels
from core.push_onepush import REQUEST_TIMEOUT, send_channel, send_channels
from core.pushkit import push
from server.app import register_topics
from server.hub import Hub
from server.service import BaasService


def channel(provider='telegram', **params):
    return {'provider': provider, 'enabled': True, 'params': params, 'proxy': ''}


def response(payload=None, status=200):
    result = Mock(status_code=status)
    result.json.return_value = payload if payload is not None else {
        'ok': True, 'code': 0, 'errcode': 0, 'access_token': 'offline-access-token',
    }
    return result


class DeliveryTests(unittest.TestCase):
    def test_all_advertised_channels_send_through_bounded_transports(self):
        for provider in provider_catalog():
            params = {key: 'offline-test-value' for key in provider['required']}
            for key in ('url', 'endpoint', 'webhook'):
                if key in params:
                    params[key] = 'https://notify.invalid/test'
            if provider['id'] == 'smtp':
                params.update(host='mail.invalid', user='test@example.invalid')
            with self.subTest(provider=provider['id']), \
                    patch('requests.Session.request', return_value=response()) as request, \
                    patch('smtplib.SMTP') as smtp:
                smtp.return_value.__enter__.return_value.send_message.return_value = {}
                result = send_channel(channel(provider['id'], **params), '离线标题', '离线正文')
                self.assertTrue(result['success'], result)
                if provider['id'] == 'smtp':
                    self.assertEqual(smtp.call_args.kwargs['timeout'], REQUEST_TIMEOUT)
                else:
                    self.assertTrue(request.called)
                    for call in request.call_args_list:
                        self.assertEqual(call.kwargs['timeout'], REQUEST_TIMEOUT)
                        self.assertNotEqual(call.kwargs.get('verify'), False)

    def test_existing_feishu_and_wecom_messages_include_title_and_content(self):
        for provider, params in (('lark', {'webhook': 'https://notify.invalid'}),
                                 ('wechatworkbot', {'key': 'https://notify.invalid'})):
            with self.subTest(provider=provider), patch('requests.Session.request', return_value=response()) as request:
                self.assertTrue(send_channel(channel(provider, **params), '标题', '正文')['success'])
                body = request.call_args.kwargs['json']
                message = body['content']['text'] if provider == 'lark' else body['text']['content']
                self.assertEqual(message, '标题\n正文')

    def test_telegram_api_proxy_and_credentials_are_preserved(self):
        settings = channel(token='offline-token', userid='-123', api_url='http://notify.invalid/api/')
        settings['proxy'] = 'socks5://127.0.0.1:1080'
        original = deepcopy(settings)
        with patch('requests.Session.request', return_value=response()) as request:
            self.assertTrue(send_channel(settings, '标题', '正文')['success'])
        args, kwargs = request.call_args
        self.assertEqual(args[1], 'http://notify.invalid/api/botoffline-token/sendMessage')
        self.assertEqual(kwargs['data']['chat_id'], '-123')
        self.assertEqual(kwargs['proxies']['https'], settings['proxy'])
        self.assertEqual(settings, original)

    def test_custom_data_preserves_json_types_and_expands_message_variables(self):
        settings = channel('custom', url='https://notify.invalid', datatype='json',
                           data={'text': '{{title}}: {{content}}', 'items': ['{{content}}', 2, True]})
        with patch('requests.Session.request', return_value=response()) as request:
            self.assertTrue(send_channel(settings, '标题', '正文')['success'])
        self.assertEqual(request.call_args.kwargs['json'], {'text': '标题: 正文', 'items': ['正文', 2, True]})

    def test_http_and_application_failures_are_not_reported_as_success(self):
        for item in (response(status=403), response({'ok': False}), response({'code': 401}), None):
            with self.subTest(item=item), patch('requests.Session.request', return_value=item):
                self.assertFalse(send_channel(channel(token='offline-token', userid='1'), '标题', '正文')['success'])
        empty = response(status=204)
        empty.json.side_effect = ValueError('empty')
        with patch('requests.Session.request', return_value=empty):
            self.assertTrue(send_channel(channel('discord', webhook='https://notify.invalid'), '标题', '正文')['success'])

    def test_failures_do_not_leak_secrets_or_prevent_next_channel(self):
        secret = 'offline-credential-must-stay-private'
        logger = Mock()
        configured = [channel(token=secret, userid='1'), channel('custom', url='https://notify.invalid')]
        with self.assertNoLogs('onepush', logging.DEBUG), patch('requests.Session.request', side_effect=[
                requests.ConnectionError('https://notify.invalid/' + secret), response()]):
            results = send_channels(logger, configured, '标题', '正文')
        self.assertEqual([item['success'] for item in results], [False, True])
        self.assertNotIn(secret, str(results) + str(logger.mock_calls))

    def test_disabled_channels_and_trigger_switches_do_not_send(self):
        disabled = dict(channel(token='offline-token', userid='1'), enabled=False)
        config = SimpleNamespace(push_onepush=[disabled], push_after_error=False, push_after_completion=False)
        with patch('requests.Session.request') as request:
            self.assertEqual(push(Mock(), config), [])
            self.assertEqual(push(Mock(), config, 'error'), [])
            config.push_after_completion = True
            self.assertEqual(push(Mock(), config), [])
        request.assert_not_called()

    def test_completion_and_error_supply_the_actual_task_message(self):
        config = SimpleNamespace(push_onepush=[channel(token='offline-token', userid='1')],
                                 push_after_error=True, push_after_completion=True)
        for error, expected in ((None, 'all activities finished'), ('具体错误', '具体错误')):
            with self.subTest(error=error), patch('requests.Session.request', return_value=response()) as request:
                push(Mock(), config, error)
                self.assertIn(expected, request.call_args.kwargs['data']['text'])


class MigrationAndProtocolTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).resolve().parents[2] / 'develop_tools/out'
        output.mkdir(exist_ok=True)
        self.scratch = Path(tempfile.mkdtemp(prefix='onepush-regression-', dir=output))
        previous = Path.cwd()
        os.chdir(self.scratch)
        self.addCleanup(os.chdir, previous)
        static = patch.object(ConfigSet, 'static_config', StaticConfig(**json.loads(STATIC_DEFAULT_CONFIG)))
        static.start()
        self.addCleanup(static.stop)
        self.path = self.scratch / 'config/account/config.json'
        self.path.parent.mkdir(parents=True)
        self.data = json.loads(DEFAULT_CONFIG)
        self.path.write_text(json.dumps(self.data), encoding='utf-8')

    def test_legacy_configuration_is_migrated_once_and_original_fields_are_preserved(self):
        del self.data['push_onepush']
        self.data.update(push_json='https://notify.invalid', push_serverchan='offline-serverchan-key',
                         push_feishu='https://notify.invalid/lark', push_wecom='https://notify.invalid/wecom',
                         push_telegram_bot_token='offline-token', push_telegram_chat_id='-1',
                         push_telegram_proxy='http://127.0.0.1:1080', push_telegram_api='https://notify.invalid/api')
        self.path.write_text(json.dumps(self.data), encoding='utf-8')
        expected = legacy_channels(self.data)
        self.assertEqual(ConfigSet('account').config.push_onepush, expected)
        check_and_update_user_config('account')
        saved = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(saved['push_onepush'], expected)
        for key, value in self.data.items():
            self.assertEqual(saved[key], value)
        ConfigSet('account').set('push_onepush', [])
        check_and_update_user_config('account')
        self.assertEqual(ConfigSet('account').config.push_onepush, [])
        self.assertEqual(json.loads(self.path.read_text(encoding='utf-8'))['push_telegram_bot_token'], 'offline-token')

    def test_invalid_edits_preserve_saved_configuration(self):
        original = self.path.read_bytes()
        for value in ({}, [None], [channel('unknown')], [channel([])], [dict(channel(), params=[])],
                      [dict(channel(), enabled='true')], [dict(channel(), proxy=123)]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ConfigSet('account').set('push_onepush', value)
            self.assertEqual(self.path.read_bytes(), original)
        # Incomplete drafts can be saved, but cannot send until credentials are completed.
        ConfigSet('account').set('push_onepush', [channel()])
        with self.assertRaises(ValueError):
            validate_channels([channel()], require_complete=True)

    def test_real_topic_rpc_saves_tests_and_delivers_subscription_updates(self):
        async def exercise():
            hub = Hub()
            hub.set_loop(asyncio.get_running_loop())
            service = BaasService(hub)
            register_topics(hub, service)
            frames = []
            websocket = Mock()

            async def send_text(raw):
                frames.append(json.loads(raw))
            websocket.send_text = send_text
            hub.connect(websocket)
            await hub.subscribe(websocket, 'ConfigArg:account')
            value = [channel(token='offline-token', userid='-1')]
            await hub.handle(websocket, {'t': 'ConfigArg:account', 'o': 'rpc', 'f': 'set',
                                        'v': {'key': 'push_onepush', 'value': value}, 'i': 1})
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertEqual(ConfigSet('account').config.push_onepush, value)
            self.assertTrue(any(item.get('o') == 'full' and item['v']['push_onepush'] == value for item in frames))
            with patch('requests.Session.request', return_value=response()) as request:
                await hub.handle(websocket, {'t': 'ConfigArg:account', 'o': 'rpc', 'f': 'push_test',
                                            'v': {'channel': value[0]}, 'i': 2})
                self.assertTrue(next(item for item in frames if item.get('i') == 2)['r']['success'])
                self.assertIn('YAB 通知测试', request.call_args.kwargs['data']['text'])
            with patch('requests.Session.request') as request:
                await hub.handle(websocket, {'t': 'ConfigArg:../account', 'o': 'rpc', 'f': 'push_test',
                                            'v': {'channel': value[0]}, 'i': 3})
                self.assertTrue(next(item for item in frames if item.get('i') == 3)['e'])
                request.assert_not_called()
            hub.disconnect(websocket)
        asyncio.run(exercise())


if __name__ == '__main__':
    unittest.main()

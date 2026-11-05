"""Offline regressions for tactical shop migration and purchase selection."""

import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import uvicorn
import websockets

from core.config.config_init import check_and_update_user_config
from core.config.config_set import ConfigSet
from core.config.default_config import DEFAULT_CONFIG, STATIC_DEFAULT_CONFIG
from core.config.generated_static_config import StaticConfig
from core.config.shop_config import migrate_tactical_shop_list, validate_tactical_shop_list
from module.shop import tactical_challenge_shop as shop
from server.service import BaasService


PRICES = json.loads(STATIC_DEFAULT_CONFIG)['tactical_challenge_shop_price_list']
LEGACY_NAMES = [
    '宫子神明文字x5', '静子神明文字x5', '真白神明文字x5', '纱绫神明文字x5',
    '风香神明文字x5', '歌原神明文字x5', '30AP', '60AP',
    '初级经验书x5', '中级经验书x10', '高级经验书x3', '特级经验书x1',
    '信用点x5k', '信用点x5k', '信用点x75k', '信用点x125k',
]


def selected_rows(flags, rows):
    return [tuple(row) for flag, row in zip(flags, rows) if flag]


class TacticalShopMigrationTests(unittest.TestCase):
    def test_old_ap_selection_moves_to_first_two_slots_and_costs_45(self):
        old = [0] * 16
        old[6:8] = [1, 1]
        for server in ('Global', 'JP'):
            with self.subTest(server=server):
                flags = migrate_tactical_shop_list(old, server, PRICES[server])
                self.assertEqual(flags, [1, 1] + [0] * 15)
                self.assertEqual(sum(flag * row[1] for flag, row in zip(flags, PRICES[server])), 45)
                self.assertEqual(old, [0] * 6 + [1, 1] + [0] * 8)

    def test_each_old_product_keeps_its_name_and_price(self):
        old_prices = [50] * 6 + [15, 30, 5, 25, 60, 100, 4, 20, 60, 100]
        for server in ('Global', 'JP'):
            for index, (name, price) in enumerate(zip(LEGACY_NAMES, old_prices)):
                with self.subTest(server=server, product=index):
                    old = [int(i == index) for i in range(16)]
                    flags = migrate_tactical_shop_list(old, server, PRICES[server])
                    self.assertEqual(selected_rows(flags, PRICES[server]), [(name, price)])

    def test_all_old_products_are_kept_and_miyu_is_not_enabled(self):
        flags = migrate_tactical_shop_list([1] * 16, 'Global', PRICES['Global'])
        self.assertEqual(sum(flags), 16)
        self.assertEqual(flags[2], 0)

    def test_current_lists_are_unchanged_and_migration_is_idempotent(self):
        for server, rows in PRICES.items():
            with self.subTest(server=server):
                original = [i % 2 for i in range(len(rows))]
                once = migrate_tactical_shop_list(original, server, rows)
                self.assertEqual(once, original)
                self.assertEqual(migrate_tactical_shop_list(once, server, rows), original)
        old = [0] * 6 + [1, 1] + [0] * 8
        once = migrate_tactical_shop_list(old, 'Global', PRICES['Global'])
        self.assertEqual(migrate_tactical_shop_list(once, 'Global', PRICES['Global']), once)

    def test_empty_legacy_defaults_are_sized_for_each_server(self):
        self.assertEqual(len(json.loads(DEFAULT_CONFIG)['TacticalChallengeShopList']), len(PRICES['CN']))
        for server, rows in PRICES.items():
            for length in (0, 14, 15, 16, 17):
                with self.subTest(server=server, length=length):
                    flags = migrate_tactical_shop_list([0] * length, server, rows)
                    self.assertEqual(flags, [0] * len(rows))

    def test_unknown_or_malformed_lists_are_preserved_and_rejected(self):
        for flags in ([1] + [0] * 13, [1] * 18, None, '1', {'0': 1},
                      [2] * 17, ['0'] * 17, [[0]] * 17, [0.0] * 17):
            with self.subTest(flags=flags):
                self.assertEqual(migrate_tactical_shop_list(flags, 'Global', PRICES['Global']), flags)
                with self.assertRaisesRegex(ValueError, '重新勾选'):
                    validate_tactical_shop_list(flags, PRICES['Global'])


class TacticalShopConfigTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).resolve().parents[2] / 'develop_tools/out'
        output.mkdir(parents=True, exist_ok=True)
        self.scratch = Path(tempfile.mkdtemp(prefix='tactical-shop-regression-', dir=output))
        previous = Path.cwd()
        os.chdir(self.scratch)
        self.addCleanup(os.chdir, previous)
        static_patch = patch.object(ConfigSet, 'static_config', StaticConfig(**json.loads(STATIC_DEFAULT_CONFIG)))
        static_patch.start()
        self.addCleanup(static_patch.stop)
        self.path = self.scratch / 'config/account/config.json'
        self.path.parent.mkdir(parents=True)

    def write_config(self, server='国际服', flags=None):
        data = json.loads(DEFAULT_CONFIG)
        data.update(server=server, name='保留名称', adbIP='192.0.2.1')
        data['TacticalChallengeShopList'] = flags if flags is not None else [0] * 6 + [1, 1] + [0] * 8
        self.path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return data

    def read_config(self):
        return json.loads(self.path.read_text(encoding='utf-8'))

    def test_bootstrap_persists_migration_without_changing_other_settings(self):
        old = self.write_config()
        check_and_update_user_config('account')
        expected = {**old, 'TacticalChallengeShopList': [1, 1] + [0] * 15}
        self.assertEqual(self.read_config(), expected)
        check_and_update_user_config('account')
        self.assertEqual(self.read_config(), expected)

    def test_bootstrap_preserves_unknown_nonempty_list_and_other_settings(self):
        old = self.write_config(flags=[1] + [0] * 13)
        check_and_update_user_config('account')
        self.assertEqual(self.read_config(), old)

    def test_reading_old_config_also_returns_migrated_selection(self):
        self.write_config()
        cs = ConfigSet('account')
        self.assertEqual(cs.config.TacticalChallengeShopList, [1, 1] + [0] * 15)
        cs.set('name', '新名称')
        self.assertEqual(self.read_config()['TacticalChallengeShopList'], [1, 1] + [0] * 15)

    def test_new_configs_have_server_appropriate_lengths(self):
        for server, mode in (('官服', 'CN'), ('国际服', 'Global'), ('日服', 'JP')):
            with self.subTest(server=server):
                self.write_config(server, json.loads(DEFAULT_CONFIG)['TacticalChallengeShopList'])
                check_and_update_user_config('account')
                self.assertEqual(self.read_config()['TacticalChallengeShopList'], [0] * len(PRICES[mode]))

    def test_invalid_new_selection_is_not_saved_or_treated_as_legacy(self):
        self.write_config(flags=[0] * 17)
        before = self.path.read_bytes()
        for flags in ([1] * 16, [1] * 18, [2] * 17, ['1'] * 17):
            with self.subTest(flags=flags), self.assertRaises(ValueError):
                ConfigSet('account').set('TacticalChallengeShopList', flags)
            self.assertEqual(self.path.read_bytes(), before)

    def test_server_switch_keeps_ap_selection_in_both_directions(self):
        self.write_config('官服')
        cs = ConfigSet('account')
        cs.set('server', '国际服')
        self.assertEqual(self.read_config()['TacticalChallengeShopList'], [1, 1] + [0] * 15)
        cs.set('server', '日服')
        self.assertEqual(self.read_config()['TacticalChallengeShopList'], [1, 1] + [0] * 15)
        cs.set('server', '官服')
        self.assertEqual(self.read_config()['TacticalChallengeShopList'], [0] * 6 + [1, 1] + [0] * 8)

    def test_server_switch_does_not_replace_miyu_with_another_product(self):
        self.write_config(flags=[1, 1, 1] + [0] * 14)
        ConfigSet('account').set('server', '官服')
        self.assertEqual(selected_rows(self.read_config()['TacticalChallengeShopList'], PRICES['CN']),
                         [('30AP', 15), ('60AP', 30)])

    def test_server_change_pushes_both_new_selection_and_shop_options(self):
        self.write_config('官服')
        hub = Mock()
        service = BaasService(hub)
        service.config_set('account', {'key': 'server', 'value': '国际服'})
        self.assertEqual([call.args[0] for call in hub.push_full.call_args_list],
                         ['ConfigArg:account', 'Panels:account'])
        self.assertEqual(service.provide_config_arg('account')['TacticalChallengeShopList'], [1, 1] + [0] * 15)

    def test_websocket_delivers_updated_selection_and_options(self):
        from server.app import create_app

        self.write_config('官服')

        async def check_messages():
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
            app = create_app(serve_webapp=False, access_token='')
            server = uvicorn.Server(uvicorn.Config(app, log_level='error'))
            running = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                for _ in range(100):
                    if server.started:
                        break
                    if running.done():
                        await running
                        self.fail('Isolated server did not start')
                    await asyncio.sleep(0.02)
                self.assertTrue(server.started)
                async with websockets.connect(f'ws://127.0.0.1:{port}/api/ws') as ws:
                    for topic in ('ConfigArg:account', 'Panels:account'):
                        await ws.send(json.dumps({'t': topic, 'o': 'sub'}))
                    subscribed = set()
                    while len(subscribed) < 2:
                        message = json.loads(await asyncio.wait_for(ws.recv(), 5))
                        if message.get('t') in ('ConfigArg:account', 'Panels:account'):
                            subscribed.add(message['t'])
                    await ws.send(json.dumps({'t': 'ConfigArg:account', 'o': 'rpc', 'f': 'set',
                                              'v': {'key': 'server', 'value': '国际服'}, 'i': 1}))
                    updates = {}
                    while len(updates) < 3:
                        message = json.loads(await asyncio.wait_for(ws.recv(), 5))
                        if message.get('i') == 1:
                            self.assertIsNone(message['e'])
                            updates['reply'] = message
                        elif message.get('t') in ('ConfigArg:account', 'Panels:account'):
                            updates[message['t']] = message['v']
                    self.assertEqual(updates['ConfigArg:account']['TacticalChallengeShopList'], [1, 1] + [0] * 15)
                    fields = [field for panel in updates['Panels:account']['panels']
                              for group in panel['groups'] for field in group['fields']]
                    field = next(field for field in fields if field['key'] == 'TacticalChallengeShopList')
                    self.assertEqual([row['name'] for row in field['options'][:3]],
                                     ['30AP', '60AP', '美游神明文字x5'])
            finally:
                server.should_exit = True
                await asyncio.wait_for(running, 5)
                listener.close()

        with patch.object(BaasService, 'init_ocr'), patch('server.app.build_meta', return_value={}):
            asyncio.run(check_messages())


class TacticalShopPurchaseTests(unittest.TestCase):
    def worker(self, flags):
        return SimpleNamespace(
            config=SimpleNamespace(TacticalChallengeShopList=flags, TacticalChallengeShopRefreshTime=0),
            static_config=SimpleNamespace(tactical_challenge_shop_price_list=deepcopy(PRICES)),
            server='Global', config_set=Mock(), logger=Mock(), to_main_page=Mock(),
        )

    def test_legacy_ap_selection_reaches_purchase_as_two_ap_bottles(self):
        worker = self.worker([0] * 6 + [1, 1] + [0] * 8)
        with patch.object(shop, 'to_common_shop'), patch.object(shop, 'goto_shop_by_name'), \
                patch.object(shop, 'get_tactical_challenge_assets', return_value=45), \
                patch.object(shop, 'get_purchase_state', return_value='shop_purchase-unavailable'), \
                patch.object(shop, 'buy') as buy:
            self.assertTrue(shop.implement(worker))
        self.assertEqual(buy.call_args.args[1].tolist(), [1, 1] + [0] * 15)
        worker.config_set.set.assert_called_once_with('TacticalChallengeShopList', [1, 1] + [0] * 15)
        worker.logger.info.assert_any_call('Assets Required : 45')

    def test_unknown_selection_stops_before_touching_game(self):
        worker = self.worker([1] + [0] * 13)
        with patch.object(shop, 'buy') as buy, self.assertRaisesRegex(ValueError, '重新勾选'):
            shop.implement(worker)
        worker.to_main_page.assert_not_called()
        worker.config_set.set.assert_not_called()
        buy.assert_not_called()

    def test_insufficient_balance_does_not_start_purchase(self):
        worker = self.worker([1, 1] + [0] * 15)
        with patch.object(shop, 'to_common_shop'), patch.object(shop, 'goto_shop_by_name'), \
                patch.object(shop, 'get_tactical_challenge_assets', return_value=44), \
                patch.object(shop, 'buy') as buy:
            self.assertTrue(shop.implement(worker))
        buy.assert_not_called()

    def test_empty_old_defaults_skip_game(self):
        worker = self.worker([0] * 14)
        self.assertTrue(shop.implement(worker))
        worker.to_main_page.assert_not_called()


if __name__ == '__main__':
    unittest.main()

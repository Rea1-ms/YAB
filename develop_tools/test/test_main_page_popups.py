"""Replay cropped game screenshots without connecting to a device."""

import runpy
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

import cv2
import numpy as np

from core.Baas_thread import Baas_thread

# isort: split
from core import image, picture, position
from core.exception import RequestHumanTakeOver
from develop_tools.test.offline_support import FrameReplay, ReplayClock, load_fixture
from module import collect_daily_free_power as free_power

ROOT = Path(__file__).resolve().parents[2]
IDENTIFIERS = ('Global_en-us', 'Global_zh-tw', 'Global_ko-kr')


class MainPagePopupTests(unittest.TestCase):
    def setUp(self):
        self.clock = ReplayClock()
        clock_patch = patch.object(picture, 'time', self.clock)
        clock_patch.start()
        self.addCleanup(clock_patch.stop)
        self.templates = {}
        self.ranges = {}
        for identifier in IDENTIFIERS:
            folder = ROOT / 'src/images' / identifier
            ranges = runpy.run_path(str(folder / 'x_y_range/main_page.py'))['x_y_range']
            self.ranges[identifier] = {'main_page': ranges}
            self.templates[identifier] = {
                'main_page_' + name: cv2.imread(str(folder / 'main_page' / (name + '.png')))
                for name in ranges if (folder / 'main_page' / (name + '.png')).is_file()
            }
        for target, values in ((position.image_dic, self.templates), (position.image_x_y_range, self.ranges)):
            patcher = patch.dict(target, values)
            patcher.start()
            self.addCleanup(patcher.stop)

    def frame(self, kind, home_visible=False):
        frame = (load_fixture('global_startup_promo_20261108') if kind == 'promo-capture'
                 else np.zeros((720, 1280, 3), dtype=np.uint8))
        fixtures = {
            'promo': [('global_startup_close.png', (1143, 48)), ('global_startup_dismiss.png', (78, 622))],
            'promo-2': [('global_startup_close.png', (1143, 48)), ('global_startup_dismiss_2.png', (78, 622))],
            'news': [('global_news_chrome.png', (35, 84)), ('global_news_close.png', (1180, 15))],
            'launch': [('global_store_login.png', (359, 136)), ('global_store_session.png', (551, 589))],
            'store': [('global_store_login.png', (359, 136)), ('global_store_no_session.png', (551, 589))],
            'checked': [('global_store_login.png', (359, 136)), ('global_store_session.png', (551, 589))],
        }
        for name, (x, y) in fixtures.get(kind, []):
            crop = load_fixture(name)
            height, width = crop.shape[:2]
            frame[y:y + height, x:x + width] = crop
        if kind == 'checked':
            cv2.polylines(frame, [np.array([[563, 609], [570, 617], [583, 601]])],
                          False, (255, 255, 255), 3)
        # Synthetic end markers make it possible to check overlay precedence.
        if kind == 'home' or home_visible:
            frame[:6, :6] = (3, 2, 1)
        if kind == 'reward':
            frame[:6, 10:16] = (6, 5, 4)
        return frame

    def worker(self, frames, identifier='Global_en-us', ratio=1):
        worker = object.__new__(Baas_thread)
        worker.server = 'Global'
        worker.identifier = identifier
        worker.ratio = ratio
        worker.is_android_device = False
        worker.flag_run = True
        worker.logger = Mock()
        worker.screenshot_interval = .1
        worker.last_click_name = ''
        worker.last_click_position = (0, 0)
        worker.last_click_time = 0
        worker.rgb_feature = {
            'main_page': [[(2, 2)], [(1, 1, 2, 2, 3, 3)]],
            'reward_acquired': [[(12, 2)], [(4, 4, 5, 5, 6, 6)]],
        }
        frames = [cv2.resize(frame, (int(1280 * ratio), int(720 * ratio))) for frame in frames]
        worker.replay = FrameReplay(frames, self.clock)
        worker.get_screenshot_array = Mock(side_effect=worker.replay.screenshot)
        worker.click = Mock(side_effect=worker.replay.click)
        worker.latest_img_array = frames[0]
        return worker

    def store_menu_frame(self):
        menu = self.frame('empty')
        for feature in ('purchase-pyroxenes-menu', 'purchase-pyroxenes-package-selected-1',
                        'purchase-pyroxenes-daily-free-purchasable'):
            name = 'main_page_' + feature
            x1, y1, x2, y2 = position.get_area('Global_en-us', name)
            template = position.image_dic['Global_en-us'][name]
            menu[y1:y2, x1:x2] = cv2.resize(template, (x2 - x1, y2 - y1))
        return menu

    def login_frames(self, kind):
        return [self.frame('launch'), self.frame('checked')] if kind == 'launch' else [self.frame(kind)]

    def login_clicks(self, kind):
        clicks = [call(572, 610, wait_over=True)] if kind == 'launch' else []
        return clicks + [call(886, 165, wait_over=True)]

    def test_startup_promotion_closes_without_close_control_in_all_languages_and_resolutions(self):
        for identifier in IDENTIFIERS:
            for ratio in (.75, 1, 1.5, 2):
                for kind in ('promo', 'promo-2'):
                    with self.subTest(identifier=identifier, ratio=ratio, kind=kind):
                        frame = self.frame(kind)
                        frame[48:104, 1143:1203] = 0
                        worker = self.worker([frame, self.frame('home')], identifier, ratio)
                        worker.to_main_page()
                        worker.click.assert_called_once_with(1173, 75, wait_over=True)

    def test_startup_promotion_closes_before_accepting_visible_home_features(self):
        worker = self.worker([self.frame('promo', home_visible=True), self.frame('home')])
        worker.to_main_page()
        worker.click.assert_called_once_with(1173, 75, wait_over=True)
        self.assertGreaterEqual(worker.get_screenshot_array.call_count, 2)

    def test_reported_startup_capture_closes_in_all_languages_and_resolutions(self):
        for identifier in IDENTIFIERS:
            for ratio in (.75, 1, 1.5, 2):
                with self.subTest(identifier=identifier, ratio=ratio):
                    worker = self.worker([self.frame('promo-capture'), self.frame('home')], identifier, ratio)
                    worker.to_main_page()
                    worker.click.assert_called_once_with(1173, 75, wait_over=True)

    def test_missed_promotion_close_waits_before_retrying_on_repeated_frames(self):
        frame = self.frame('promo-capture')
        worker = self.worker([frame] * 6 + [self.frame('home')])
        worker.to_main_page()
        self.assertEqual(worker.click.call_args_list, [call(1173, 75, wait_over=True)] * 2)
        self.assertEqual([action['frame'] for action in worker.replay.actions], [0, 5])
        first, second = worker.replay.actions
        self.assertGreater(second['time'] - first['time'], 2)

    def test_promotion_click_without_a_confirmed_next_screen_cannot_finish(self):
        worker = self.worker([self.frame('promo-capture')] * 4)
        with self.assertRaisesRegex(AssertionError, '回放帧已用完'):
            worker.to_main_page()
        worker.click.assert_called_once_with(1173, 75, wait_over=True)

    def test_startup_promotion_requires_footer_control(self):
        for kind in ('promo', 'promo-2'):
            with self.subTest(kind=kind):
                frame = self.frame(kind)
                frame[622:670, 78:126] = 0
                worker = self.worker([frame])
                self.assertFalse(picture.handle_global_main_page_overlay(worker))
                worker.click.assert_not_called()

    def test_startup_promotion_does_not_depend_on_banner_artwork_or_label(self):
        frame = self.frame('promo')
        frame[110:620, 82:1205] = (90, 180, 230)
        frame[628:664, 123:302] = (220, 100, 70)
        worker = self.worker([frame, self.frame('home')])
        worker.to_main_page()
        worker.click.assert_called_once_with(1173, 75, wait_over=True)

    def test_startup_promotion_does_not_repeat_click_on_a_stale_frame(self):
        worker = self.worker([self.frame('promo'), self.frame('home')])
        self.assertTrue(picture.handle_global_main_page_overlay(worker))
        self.assertTrue(picture.handle_global_main_page_overlay(worker))
        worker.click.assert_called_once_with(1173, 75, wait_over=True)

    def test_news_ui_is_recognized_independently_of_game_language_and_resolution(self):
        for identifier in IDENTIFIERS:
            for ratio in (.75, 1, 1.5, 2):
                with self.subTest(identifier=identifier, ratio=ratio):
                    worker = self.worker([self.frame('news'), self.frame('home')], identifier, ratio)
                    self.assertTrue(picture.handle_global_main_page_overlay(worker))
                    worker.click.assert_called_once_with(1214, 43, wait_over=True)

    def test_news_closes_before_accepting_visible_home_features(self):
        worker = self.worker([self.frame('news', home_visible=True), self.frame('home')])
        worker.to_main_page()
        worker.click.assert_called_once_with(1214, 43, wait_over=True)
        self.assertGreaterEqual(worker.get_screenshot_array.call_count, 2)

    def test_news_requires_both_toolbar_and_close_button(self):
        for area in ((35, 84, 106, 655), (1180, 15, 1255, 77)):
            frame = self.frame('news')
            x1, y1, x2, y2 = area
            frame[y1:y2, x1:x2] = 0
            worker = self.worker([frame])
            self.assertFalse(picture.handle_global_main_page_overlay(worker))
            worker.click.assert_not_called()

    def test_launch_prompt_checks_suppression_then_closes_without_logging_in(self):
        for ratio in (1, 2):
            with self.subTest(ratio=ratio):
                worker = self.worker([self.frame('launch'), self.frame('checked'), self.frame('home')], ratio=ratio)
                worker.to_main_page()
                self.assertEqual(worker.click.call_args_list, [
                    call(572, 610, wait_over=True), call(886, 165, wait_over=True),
                ])

    def test_checkbox_can_also_dismiss_the_launch_prompt_immediately(self):
        worker = self.worker([self.frame('launch'), self.frame('home')])
        worker.to_main_page()
        worker.click.assert_called_once_with(572, 610, wait_over=True)

    def test_checked_prompt_is_not_toggled_off(self):
        worker = self.worker([self.frame('checked'), self.frame('home')])
        self.assertFalse(image.compare_image(worker, 'main_page_login-store-session-unchecked', threshold=.95))
        worker.to_main_page()
        worker.click.assert_called_once_with(886, 165, wait_over=True)

    def test_optional_home_prompt_without_checkbox_is_closed(self):
        worker = self.worker([self.frame('store'), self.frame('home')])
        worker.to_main_page()
        worker.click.assert_called_once_with(886, 165, wait_over=True)

    def test_same_frame_does_not_click_checkbox_twice(self):
        worker = self.worker([self.frame('launch'), self.frame('home')])
        self.assertTrue(picture.handle_global_main_page_overlay(worker))
        self.assertTrue(picture.handle_global_main_page_overlay(worker))
        worker.click.assert_called_once_with(572, 610, wait_over=True)

    def test_other_servers_do_not_use_global_overlay_buttons(self):
        for server in ('CN', 'JP'):
            for kind in ('launch', 'promo'):
                with self.subTest(server=server, kind=kind):
                    worker = self.worker([self.frame(kind)])
                    worker.server = server
                    self.assertFalse(picture.handle_global_main_page_overlay(worker))
                    worker.click.assert_not_called()

    def test_navigation_stages_dismiss_a_delayed_login_before_continuing(self):
        stages = [
            (free_power.to_purchase_pyroxenes_menu, (), self.store_menu_frame()),
            (free_power.to_purchase_type, ('package',), self.store_menu_frame()),
            (free_power.detect_free_power_availability, (), self.store_menu_frame()),
            (free_power.return_to_main_page, (), self.frame('home')),
        ]
        for function, args, target in stages:
            for kind in ('store', 'launch', 'checked'):
                with self.subTest(stage=function.__name__, kind=kind):
                    worker = self.worker(self.login_frames(kind) + [target])
                    function(worker, *args)
                    self.assertEqual(worker.click.call_args_list, self.login_clicks(kind))

    def test_late_startup_prompt_after_store_entry_still_allows_collection(self):
        for kind in ('store', 'launch', 'checked'):
            for ratio in (1, 2):
                with self.subTest(kind=kind, ratio=ratio):
                    frames = ([self.frame('home')] + self.login_frames(kind)
                              + [self.store_menu_frame(), self.frame('reward'), self.frame('home')])
                    worker = self.worker(frames, ratio=ratio)
                    self.assertTrue(free_power.implement(worker))
                    self.assertEqual(worker.click.call_args_list, [call(982, 28)] + self.login_clicks(kind)
                                     + [call(385, 479), call(640, 180)])

    def test_claim_guard_starts_after_the_actual_free_product_click(self):
        for kind in ('store', 'launch', 'checked'):
            with self.subTest(kind=kind):
                worker = self.worker(self.login_frames(kind) + [self.store_menu_frame(), self.frame('store')])
                with self.assertRaisesRegex(RequestHumanTakeOver, '应用商店未登录'):
                    free_power.collect_daily_free_power(worker)
                self.assertEqual(worker.click.call_args_list, self.login_clicks(kind) + [call(385, 479)])

    def test_task_stops_on_login_after_claim_without_dismissing_or_restarting(self):
        for kind in ('store', 'launch', 'checked'):
            with self.subTest(kind=kind):
                worker = self.worker([self.frame('home'), self.store_menu_frame(), self.frame(kind)])
                worker.push_and_log_error_msg = Mock()
                worker.deal_with_func_call_timeout = Mock()
                worker.deal_with_package_incorrect = Mock()
                self.assertFalse(worker.solve('collect_daily_free_power'))
                self.assertEqual(worker.click.call_args_list, [call(982, 28), call(385, 479)])
                worker.push_and_log_error_msg.assert_called_once()
                self.assertIn('应用商店未登录', worker.push_and_log_error_msg.call_args.args[1])
                worker.deal_with_func_call_timeout.assert_not_called()
                worker.deal_with_package_incorrect.assert_not_called()

    def test_task_stops_when_login_repeatedly_blocks_store_entry(self):
        worker = self.worker([self.frame('home'), self.frame('store'), self.frame('home'), self.frame('store')])
        worker.push_and_log_error_msg = Mock()
        worker.deal_with_func_call_timeout = Mock()
        worker.deal_with_package_incorrect = Mock()
        self.assertFalse(worker.solve('collect_daily_free_power'))
        self.assertEqual(worker.click.call_args_list, [call(982, 28), call(886, 165, wait_over=True), call(982, 28)])
        worker.push_and_log_error_msg.assert_called_once()
        self.assertIn('登录提示反复出现', worker.push_and_log_error_msg.call_args.args[1])
        worker.deal_with_func_call_timeout.assert_not_called()
        worker.deal_with_package_incorrect.assert_not_called()

    def test_repeated_session_checkbox_also_stops_before_another_retry(self):
        worker = self.worker([self.frame('home'), self.frame('launch'), self.frame('home'), self.frame('launch')])
        with self.assertRaisesRegex(RequestHumanTakeOver, '登录提示反复出现'):
            free_power.implement(worker)
        self.assertEqual(worker.click.call_args_list, [call(982, 28), call(572, 610, wait_over=True), call(982, 28)])

    def test_duplicate_frames_do_not_use_up_another_login_dismissal(self):
        for kind in ('store', 'launch'):
            with self.subTest(kind=kind):
                worker = self.worker([self.frame(kind), self.frame('home')])
                guard = free_power.StoreLoginGuard()
                self.assertTrue(picture.handle_global_main_page_overlay(worker, guard.before_reaction))
                self.assertTrue(picture.handle_global_main_page_overlay(worker, guard.before_reaction))
                worker.click.assert_called_once_with(*((572, 610) if kind == 'launch' else (886, 165)), wait_over=True)

    def test_store_service_error_also_stops_before_generic_retry(self):
        frame = self.frame('empty')
        name = 'main_page_store-service-unavailable'
        area = position.get_area('Global_en-us', name)
        template = position.image_dic['Global_en-us'][name]
        x1, y1, x2, y2 = area
        frame[y1:y2, x1:x2] = cv2.resize(template, (x2 - x1, y2 - y1))
        worker = self.worker([frame])
        with self.assertRaisesRegex(RequestHumanTakeOver, '商店服务不可用'):
            free_power.to_purchase_pyroxenes_menu(worker)
        worker.click.assert_not_called()

    def test_logged_in_store_still_collects_free_power(self):
        menu = self.store_menu_frame()
        worker = self.worker([self.frame('home'), menu, self.frame('reward'), self.frame('home')])
        self.assertTrue(free_power.implement(worker))
        self.assertEqual(worker.click.call_args_list, [call(982, 28), call(385, 479), call(640, 180)])


if __name__ == '__main__':
    unittest.main()

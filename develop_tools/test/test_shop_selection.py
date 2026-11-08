"""Offline regressions for missed shop slots and stalled selection."""

import unittest
from itertools import count
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import cv2
import numpy as np

from core import color, position
from core.exception import RequestHumanTakeOver
from module.shop import shop_utils as shop

ROOT = Path(__file__).resolve().parents[2]


class ShopRecognitionTests(unittest.TestCase):
    def setUp(self):
        templates = {
            'shop_' + path.stem: cv2.imread(str(path))
            for path in (ROOT / 'src/images/Global_en-us/shop').glob('*.png')
        }
        patcher = patch.dict(position.image_dic, {'Global_en-us': templates})
        patcher.start()
        self.addCleanup(patcher.stop)

    def worker(self, ratio=1):
        crop = cv2.imread(str(Path(__file__).with_name('fixtures') / 'global_shop_last_row.png'))
        self.assertIsNotNone(crop)
        frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        frame[350:605, 620:1225] = crop
        return SimpleNamespace(
            server='Global', identifier='Global_en-us', ratio=ratio,
            latest_img_array=cv2.resize(frame, (int(1280 * ratio), int(720 * ratio))),
        )

    def test_reported_screenshot_recognizes_all_four_bottom_slots(self):
        for ratio in (1, 1.5, 2):
            with self.subTest(ratio=ratio):
                items, rows = shop.get_item_position(self.worker(ratio))
                self.assertEqual([item[0][0] for item in items], [0, 1, 2, 3])
                self.assertEqual(rows[0][1], 4)

    def test_second_column_is_recovered_when_its_color_probe_misses(self):
        original = color.rgb_in_range

        def miss_second_column(worker, x, *args, **kwargs):
            return False if x == 800 else original(worker, x, *args, **kwargs)

        with patch.object(color, 'rgb_in_range', side_effect=miss_second_column):
            items, rows = shop.get_item_position(self.worker())
        self.assertEqual([item[0][0] for item in items], [0, 1, 2, 3])
        self.assertEqual(rows, [(530, 4)])

    def test_missing_currency_is_not_guessed_from_neighboring_slots(self):
        worker = self.worker()
        worker.latest_img_array[510:590, 780:865] = 0
        items, rows = shop.get_item_position(worker)
        self.assertEqual([item[0][0] for item in items], [0, 2, 3])
        self.assertEqual(rows, [(530, 3)])


class ShopSelectionTests(unittest.TestCase):
    def worker(self):
        return SimpleNamespace(server='Global', flag_run=True, logger=Mock(),
                               update_screenshot_array=Mock(), click=Mock())

    def row(self, columns=(0, 1, 2, 3), y=300):
        return ([((col, y), True, 'creditpoints') for col in columns], [(y, len(columns))])

    def flags(self, *indices, length=24):
        return np.array([int(i + 1 in indices) for i in range(length)])

    def test_items_22_and_24_keep_their_column_numbers(self):
        worker = self.worker()
        with patch.object(shop, 'get_item_position', return_value=self.row()), \
                patch.object(shop, 'swipe_get_y_diff', return_value=250), \
                patch.object(shop, 'ensure_choose') as choose:
            shop.buy(worker, self.flags(22, 24))
        self.assertEqual([item[0][0] for item in choose.call_args.args[1]], [1, 3])
        self.assertEqual(choose.call_count, 6)

    def test_missing_item_22_retries_without_selecting_item_23_or_24(self):
        worker = self.worker()
        frames = [self.row()] * 5 + [self.row((0, 2, 3))] * 3
        with patch.object(shop, 'get_item_position', side_effect=frames), \
                patch.object(shop, 'swipe_get_y_diff', return_value=250) as swipe, \
                patch.object(shop, 'ensure_choose') as choose, \
                self.assertRaisesRegex(RuntimeError, '第 22 件'):
            shop.buy(worker, self.flags(22))
        self.assertTrue(all(not args.args[1] for args in choose.call_args_list))
        self.assertEqual(worker.update_screenshot_array.call_count, 2)
        self.assertEqual(swipe.call_count, 5)

    def test_transient_missed_slot_recovers_without_advancing_the_row(self):
        frames = [self.row()] * 5 + [self.row((0, 2, 3)), self.row()]
        with patch.object(shop, 'get_item_position', side_effect=frames), \
                patch.object(shop, 'swipe_get_y_diff', return_value=250), \
                patch.object(shop, 'ensure_choose') as choose:
            shop.buy(self.worker(), self.flags(22))
        self.assertEqual(choose.call_args.args[1][0][0][0], 1)

    def test_overlapping_rows_are_not_counted_twice(self):
        first_items, first_rows = self.row(y=300)
        last_items, last_rows = self.row(y=550)
        overlap_items, overlap_rows = self.row(y=100)
        next_items, next_rows = self.row(y=350)
        frames = [(first_items + last_items, first_rows + last_rows),
                  (overlap_items + next_items, overlap_rows + next_rows)]
        with patch.object(shop, 'get_item_position', side_effect=frames), \
                patch.object(shop, 'swipe_get_y_diff', return_value=450), \
                patch.object(shop, 'ensure_choose') as choose:
            shop.buy(self.worker(), self.flags(10, length=12))
        self.assertEqual(choose.call_count, 3)
        self.assertEqual(choose.call_args.args[1][0][0], (1, 350))

    def test_bottom_without_progress_stops_after_three_swipes(self):
        with patch.object(shop, 'get_item_position', return_value=self.row()), \
                patch.object(shop, 'swipe_get_y_diff', return_value=0) as swipe, \
                patch.object(shop, 'ensure_choose'), \
                self.assertRaisesRegex(RuntimeError, '滑动没有进展'):
            shop.buy(self.worker(), self.flags(22))
        self.assertEqual(swipe.call_count, 3)

    def test_empty_detection_stops_without_attempting_a_swipe(self):
        with patch.object(shop, 'get_item_position', return_value=([], [])), \
                patch.object(shop, 'swipe_get_y_diff') as swipe, \
                self.assertRaisesRegex(RuntimeError, '连续三次'):
            shop.buy(self.worker(), self.flags(22))
        swipe.assert_not_called()

    def test_tactical_shop_last_row_can_have_one_item(self):
        frames = [self.row()] * 4 + [self.row((0,))]
        with patch.object(shop, 'get_item_position', side_effect=frames), \
                patch.object(shop, 'swipe_get_y_diff', return_value=250), \
                patch.object(shop, 'ensure_choose') as choose:
            shop.buy(self.worker(), self.flags(17, length=17), 'tactical_challenge_shop')
        self.assertEqual(choose.call_args.args[1], self.row((0,))[0])

    def test_unrecognized_checkmark_stops_after_three_clicks(self):
        worker = self.worker()
        with patch.object(shop.image, 'search_in_area', return_value=False), \
                patch.object(shop.time, 'monotonic', side_effect=count(0, 0.6)), \
                self.assertRaisesRegex(RuntimeError, '连续三次勾选'):
            shop.ensure_choose(worker, self.row((1,))[0])
        self.assertEqual(worker.click.call_count, 3)

    def test_selection_deadline_and_stop_request_are_honored(self):
        worker = self.worker()
        with patch.object(shop.time, 'monotonic', side_effect=[0, 16]), \
                self.assertRaisesRegex(RuntimeError, '15 秒'):
            shop.ensure_choose(worker, self.row((1,))[0])
        worker.click.assert_not_called()
        worker.flag_run = False
        with self.assertRaises(RequestHumanTakeOver):
            shop.ensure_choose(worker, self.row((1,))[0])
        with self.assertRaises(RequestHumanTakeOver):
            shop.buy(worker, self.flags(22))


if __name__ == '__main__':
    unittest.main()

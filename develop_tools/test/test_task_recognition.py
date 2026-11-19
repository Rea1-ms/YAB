"""Exercise AP parsing and lesson sampling without a game client."""

import unittest
from types import SimpleNamespace
from unittest.mock import ANY, Mock

import numpy as np

from core.Baas_thread import Baas_thread
from module import lesson


class TaskRecognitionTests(unittest.TestCase):
    def ap_worker(self, reading):
        worker = object.__new__(Baas_thread)
        worker.server = 'Global'
        worker.ocr = Mock()
        worker.ocr.get_region_res.return_value = reading
        worker.config_set = Mock()
        worker.logger = Mock()
        return worker

    def test_ap_accepts_empty_meter_and_valid_overflow(self):
        for reading, count, maximum in (('0/240', 0, 240), ('999/240', 999, 240)):
            with self.subTest(reading=reading):
                worker = self.ap_worker(reading)
                self.assertEqual(worker.get_ap(is_main_page=True), count)
                worker.config_set.set.assert_called_once_with('ap', {'count': count, 'max': maximum, 'time': ANY})

    def test_ap_does_not_save_malformed_or_out_of_range_results(self):
        for reading in ('45', '45/', '/240', '45/240/2', '45/0', '1000/240', '45/1000', '-1/240'):
            with self.subTest(reading=reading):
                worker = self.ap_worker(reading)
                self.assertEqual(worker.get_ap(), 999)
                worker.config_set.set.assert_not_called()
                worker.logger.warning.assert_called_once()

    def test_lesson_counts_hearts_instead_of_sampling_their_edges(self):
        frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        frame[294, (354, 282)] = (210, 200, 240)
        frame[444, 698] = (210, 200, 240)
        for server in ('Global', 'CN', 'JP'):
            with self.subTest(server=server):
                worker = SimpleNamespace(server=server, ratio=1, latest_img_array=frame)
                self.assertEqual(lesson.get_lesson_relationship_counts(worker), [2, 0, 0, 0, 1, 0, 0, 0, 0])

    def test_lesson_availability_samples_portraits_not_the_outer_edge(self):
        frame = np.zeros((720, 1280, 3), dtype=np.uint8)
        frame[307:309, 158:186] = 255
        frame[575:580, 171:181] = 255
        worker = SimpleNamespace(ratio=1, latest_img_array=frame)
        self.assertEqual(lesson.check_region_availability(worker, 0), 'done')
        self.assertEqual(lesson.check_region_availability(worker, 6), 'available')


if __name__ == '__main__':
    unittest.main()

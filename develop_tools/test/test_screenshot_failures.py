"""MuMu screenshots preserve colors and stop safely when capture fails."""

import ctypes
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import cv2
import numpy as np

from core import color, position
from core.Baas_thread import Baas_thread
from core.device.nemu_client import NemuClient, NemuIpcError
from core.device.Screenshot import Screenshot
from core.device.screenshot.nemu import NemuScreenshot
from core.exception import RequestHumanTakeOver
from develop_tools.test.offline_support import ROOT, load_fixture


class ScreenshotFailureTests(unittest.TestCase):
    def client(self, capture=None):
        with patch('core.device.nemu_client.os.path.exists', return_value=True), \
                patch('core.device.nemu_client.ctypes.CDLL', return_value=SimpleNamespace(
                    nemu_capture_display=capture)):
            client = NemuClient('unused-emulator-path', 0, Mock())
        client.connect_id = 1

        def close():
            client._executor.shutdown(wait=True)

        self.addCleanup(close)
        return client

    def test_reported_home_is_recognized_through_native_capture(self):
        source = load_fixture('global_home_mumu_20261113')
        for ratio in (.75, 1, 1.5, 2):
            with self.subTest(ratio=ratio):
                frame = cv2.resize(source, (int(1280 * ratio), int(720 * ratio)))
                # Match the RGBA buffer documented by the upstream device method.
                # A PNG alone does not establish the actual DLL's channel order.
                native_pixels = cv2.flip(cv2.cvtColor(frame, cv2.COLOR_BGR2RGBA), 0)
                height, width = frame.shape[:2]

                def capture(_connection, _display, length, width_ptr, height_ptr, pixels,
                            frame_width=width, frame_height=height, raw=native_pixels):
                    width_ptr.contents.value, height_ptr.contents.value = frame_width, frame_height
                    if length:
                        self.assertEqual(length, raw.nbytes)
                        ctypes.memmove(pixels.contents, raw.tobytes(), length)
                    return 0

                adapter = object.__new__(NemuScreenshot)
                adapter.nemu_client, adapter.logger = self.client(capture), Mock()
                worker = object.__new__(Baas_thread)
                worker.flag_run, worker.is_android_device = True, True
                worker.server, worker.identifier = 'Global', 'Global_zh-tw'
                worker.current_game_activity, worker.dailyGameActivity = None, None
                worker.project_dir, worker.logger = str(ROOT), Mock()
                worker.resolution, worker.ratio = (1280, 720), 1
                worker.latest_img_array = None
                worker.click = Mock()
                worker.screenshot_interval = 0
                worker.screenshot = object.__new__(Screenshot)
                worker.screenshot.Baas_instance = worker
                worker.screenshot.screenshot_instance = adapter
                worker.screenshot.screenshot_interval = 0
                worker.screenshot.last_screenshot_time = 0
                self.assertTrue(worker.init_rgb())
                worker.update_screenshot_array()
                np.testing.assert_array_equal(worker.latest_img_array, frame)
                identifier = worker.identifier
                with patch.dict(position.initialized_image, {identifier: False}), \
                        patch.dict(position.image_dic, {identifier: {}}), \
                        patch.dict(position.image_x_y_range, {identifier: {}}):
                    self.assertTrue(worker.init_image_resource())
                    worker.to_main_page()
                np.testing.assert_array_equal(worker.latest_img_array, frame)
                self.assertTrue(color.match_rgb_feature(worker, 'main_page'))
                self.assertEqual(worker.resolution, (width, height))
                self.assertEqual(worker.ratio, ratio)
                worker.click.assert_not_called()

    def test_reference_rgb_and_yab_bgr_preserve_the_same_colors(self):
        frame = load_fixture('global_home_mumu_20261113')
        raw = cv2.cvtColor(frame, cv2.COLOR_BGR2RGBA)
        upstream_yab = cv2.cvtColor(raw, cv2.COLOR_BGRA2RGB)
        yab = cv2.cvtColor(raw, cv2.COLOR_RGBA2BGR)
        src = cv2.cvtColor(raw, cv2.COLOR_BGRA2BGR)
        epic_seven = cv2.cvtColor(raw, cv2.COLOR_RGBA2RGB)
        np.testing.assert_array_equal(yab, frame)
        np.testing.assert_array_equal(yab, upstream_yab)
        np.testing.assert_array_equal(cv2.cvtColor(yab, cv2.COLOR_BGR2RGB), src)
        np.testing.assert_array_equal(src, epic_seven)

    def test_capture_exhaustion_raises_the_original_failure(self):
        adapter = object.__new__(NemuScreenshot)
        error = NemuIpcError('screencap rpc error: 1722')
        adapter.nemu_client = Mock()
        adapter.nemu_client.screenshot.side_effect = error
        adapter.logger = Mock()
        with self.assertRaisesRegex(NemuIpcError, '3') as caught:
            adapter.screenshot()
        self.assertIs(caught.exception.__cause__, error)
        self.assertEqual(adapter.nemu_client.screenshot.call_count, 3)

    def test_temporary_failure_can_recover_without_returning_an_empty_frame(self):
        adapter = object.__new__(NemuScreenshot)
        frame = np.zeros((2, 3, 3), dtype=np.uint8)
        adapter.nemu_client, adapter.logger = Mock(), Mock()
        adapter.nemu_client.screenshot.side_effect = [NemuIpcError('1722'), None, frame]
        self.assertIs(adapter.screenshot(), frame)
        self.assertEqual(adapter.nemu_client.screenshot.call_count, 3)

    def test_invalid_screenshots_stop_before_recognition_or_clicks(self):
        for frame in (None, np.empty((0, 4, 3), dtype=np.uint8),
                      np.zeros((4, 4), dtype=np.uint8)):
            with self.subTest(shape=getattr(frame, 'shape', None)):
                worker = object.__new__(Baas_thread)
                worker.flag_run, worker.server, worker.is_android_device = True, 'Global', True
                worker.rgb_feature = {}
                worker.screenshot = Mock()
                worker.screenshot.screenshot.return_value = frame
                worker.click, worker.logger = Mock(), Mock()
                with patch('core.picture.handle_global_main_page_overlay',
                           side_effect=AssertionError('Invalid frame reached recognition')) as detect, \
                        self.assertRaisesRegex(RequestHumanTakeOver, '截图'):
                    worker.to_main_page()
                detect.assert_not_called()
                worker.click.assert_not_called()

    def test_timed_out_native_call_does_not_overlap_a_retry(self):
        client = self.client()
        started, release = threading.Event(), threading.Event()
        second = Mock(__name__='nemu_capture_display', return_value=0)

        def blocked():
            started.set()
            release.wait(2)
            return 0

        try:
            with self.assertRaises(NemuIpcError):
                client.ev_run_sync(blocked, timeout=.01)
            self.assertTrue(started.is_set())
            with self.assertRaises(NemuIpcError):
                client.ev_run_sync(second, timeout=.01)
            second.assert_not_called()
        finally:
            release.set()
        client._executor.submit(lambda: None).result(timeout=1)
        self.assertEqual(client.ev_run_sync(second), 0)
        second.assert_called_once_with()

    def test_failed_native_call_is_not_repeated_to_capture_global_output(self):
        client = self.client()
        calls = []

        def nemu_capture_display():
            calls.append(True)
            return 1722

        with patch('core.device.nemu_client.CaptureNemuIpc') as capture_output, \
                self.assertRaisesRegex(NemuIpcError, '1722'):
            client.ev_run_sync(nemu_capture_display)
        self.assertEqual(len(calls), 1)
        capture_output.assert_not_called()

    def test_invalid_native_resolution_is_rejected(self):
        def capture(_connection, _display, _length, width, height, _pixels):
            width.contents.value, height.contents.value = 0, 720
            return 0

        with self.assertRaises(NemuIpcError):
            self.client(capture).screenshot()

    def test_resolution_change_during_capture_is_rejected(self):
        def capture(_connection, _display, length, width, height, _pixels):
            width.contents.value, height.contents.value = (4 if length else 3), 2
            return 0

        with self.assertRaisesRegex(NemuIpcError, '分辨率'):
            self.client(capture).screenshot()


if __name__ == '__main__':
    unittest.main()

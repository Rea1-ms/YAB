"""真琴夏日活动的截图回放；不连接设备或执行真实战斗。"""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from core import image
from core.config.default_config import STATIC_DEFAULT_CONFIG
from develop_tools.test import test_main_page_popups as popup_tests
from develop_tools.test.offline_support import load_fixture
from module import (
    explore_activity_challenge,
    explore_activity_mission,
    explore_activity_story,
    sweep_activity,
)
from module.activities import activity_utils

ACTIVITY = 'SetSailPandemoniumShip'
HOME = 'global_makoto_activity_home'
STORY = 'global_makoto_activity_story'
QUEST = 'global_makoto_activity_quest'
RATIOS = (.75, 1, 1.5, 2)


class CurrentActivityTests(unittest.TestCase):
    def setUp(self):
        self.harness = popup_tests.MainPagePopupTests()
        self.harness.setUp()
        self.addCleanup(self.harness.doCleanups)

    def worker(self, frames, ratio=1, identifier='Global_en-us', activity=ACTIVITY):
        return self.harness.android_worker(frames, ratio, identifier, activity)

    def home_with_end_marker(self):
        # The home screenshot is real; only the RGB end marker is synthetic.
        frame = load_fixture(HOME)
        frame[:6, :6] = (3, 2, 1)
        return frame

    def test_default_activity_and_stage_data_match_current_event(self):
        self.assertEqual(json.loads(STATIC_DEFAULT_CONFIG)['current_game_activity']['Global'], ACTIVITY)
        data = activity_utils.get_stage_data(SimpleNamespace(current_game_activity=ACTIVITY))
        self.assertEqual(data['total_story'], 9)
        self.assertEqual(data['mission'], ['burst'] * 12)
        self.assertEqual(data['sweep_ap_cost_mission'], [0] + [10] * 4 + [15] * 4 + [20] * 4)
        self.assertEqual(data['grid_tasks_challenge'], [])
        self.assertFalse(data['has_draw_card'])
        self.assertFalse(data['has_exchange_reward'])

    def test_entry_matches_in_all_languages_and_resolutions(self):
        frame = load_fixture(HOME)
        for identifier in popup_tests.IDENTIFIERS:
            for ratio in RATIOS:
                with (self.subTest(identifier=identifier, ratio=ratio),
                      self.worker([frame], ratio, identifier) as worker):
                    self.assertTrue(image.compare_image(worker, 'activity_enter1'))
                    worker.control.click.assert_not_called()

    def test_legacy_activity_does_not_match_new_entry(self):
        for identifier in popup_tests.IDENTIFIERS:
            with (self.subTest(identifier=identifier),
                  self.worker([load_fixture(HOME)], identifier=identifier,
                              activity='HighlanderRailroadExplosionIncident') as worker):
                self.assertFalse(image.compare_image(worker, 'activity_enter1'))
                worker.control.click.assert_not_called()

    def test_home_entry_waits_for_story_page_and_retries_missed_clicks(self):
        frames = [load_fixture(HOME)] * 6 + [load_fixture(STORY)]
        for ratio in RATIOS:
            with self.subTest(ratio=ratio), self.worker(frames, ratio) as worker:
                activity_utils.to_activity(worker, 'story')
                click = call(int(1196 * ratio), int(195 * ratio))
                self.assertEqual(worker.control.click.call_args_list, [click] * 2)
                self.assertEqual([action['frame'] for action in worker.replay.actions], [0, 4])
                first, second = worker.replay.actions
                self.assertGreaterEqual(second['time'] - first['time'], 2)
                self.assertEqual(worker.replay.index, 6)
                self.assertTrue(image.compare_image(worker, 'activity_story-chosen-1'))

    def test_quest_switch_retries_without_accepting_stale_story_page(self):
        frames = [load_fixture(STORY)] * 7 + [load_fixture(QUEST)]
        for ratio in RATIOS:
            with self.subTest(ratio=ratio), self.worker(frames, ratio) as worker:
                activity_utils.to_activity(worker, 'mission')
                click = call(int(1200 * ratio), int(91 * ratio))
                self.assertEqual(worker.control.click.call_args_list, [click] * 2)
                first, second = worker.replay.actions
                self.assertGreater(second['time'] - first['time'], 2)
                self.assertEqual(worker.replay.index, 7)
                self.assertTrue(image.compare_image(worker, 'activity_mission-chosen-1'))

    def test_quest_to_story_uses_the_two_tab_layout(self):
        frames = [load_fixture(QUEST), load_fixture(STORY)]
        for ratio in RATIOS:
            with self.subTest(ratio=ratio), self.worker(frames, ratio) as worker:
                activity_utils.to_activity(worker, 'story')
                worker.control.click.assert_called_once_with(int(936 * ratio), int(89 * ratio))
                self.assertEqual(worker.replay.index, 1)
                self.assertTrue(image.compare_image(worker, 'activity_story-chosen-1'))

    def test_clicked_entry_without_observed_event_page_cannot_finish(self):
        with self.worker([load_fixture(HOME)] * 4) as worker:
            with self.assertRaisesRegex(AssertionError, '回放帧已用完'):
                activity_utils.to_activity(worker, 'story')
            worker.control.click.assert_called_once_with(1196, 195)

    def test_quest_switch_without_observed_selection_cannot_finish(self):
        with self.worker([load_fixture(STORY)] * 3) as worker:
            with self.assertRaisesRegex(AssertionError, '回放帧已用完'):
                activity_utils.to_activity(worker, 'mission')
            worker.control.click.assert_called_once_with(1200, 91)

    def test_missing_entry_artwork_never_clicks_the_activity_position(self):
        frame = load_fixture(HOME)
        frame[164:212, 1152:1232] = 0
        with self.worker([frame]) as worker:
            with self.assertRaisesRegex(AssertionError, '回放帧已用完'):
                activity_utils.to_activity(worker, 'story')
            worker.control.click.assert_not_called()

    def test_no_challenge_skips_navigation_and_clicks(self):
        worker = SimpleNamespace(current_game_activity=ACTIVITY, logger=Mock(),
                                 to_main_page=Mock(), click=Mock())
        self.assertTrue(explore_activity_challenge.implement(worker))
        worker.to_main_page.assert_not_called()
        worker.click.assert_not_called()
        self.assertTrue(any('没有独立挑战' in item.args[0] for item in worker.logger.info.call_args_list))

    def test_sweep_uses_current_stage_data_after_real_navigation(self):
        frames = [self.home_with_end_marker(), load_fixture(STORY), load_fixture(QUEST)]
        with (self.worker(frames) as worker,
              patch.object(activity_utils, 'to_mission_task_info') as select_stage,
              patch.object(activity_utils.color, 'check_sweep_availability', return_value='sss'),
              patch.object(activity_utils, 'start_sweep', return_value='sweep_complete') as sweep):
            # Stage detail, AP and completion are simulated; navigation uses real screenshots.
            worker.config = SimpleNamespace(activity_sweep_times='2', activity_sweep_task_number=9)
            worker.get_ap = Mock(return_value=40)
            self.assertTrue(sweep_activity.implement(worker))
            select_stage.assert_called_once_with(worker, 9, 12)
            sweep.assert_called_once_with(worker, True)
            self.assertEqual(worker.stage_data['sweep_ap_cost_mission'][9], 20)
            self.assertEqual(worker.control.click.call_args_list,
                             [call(1196, 195), call(1200, 91), call(1032, 299)])
            self.assertEqual(worker.replay.index, 2)

    def test_story_exploration_stops_at_ninth_cleared_story(self):
        frames = [self.home_with_end_marker(), load_fixture(STORY)]
        with (self.worker(frames) as worker,
              patch.object(activity_utils, 'to_story_task_info', return_value='main_story_episode-info') as select,
              patch.object(activity_utils, 'check_sweep_availability', return_value='sss'),
              patch.object(activity_utils, 'start_story') as start):
            # Cleared stages are simulated to verify the configured final story boundary.
            self.assertTrue(explore_activity_story.implement(worker))
            self.assertEqual(select.call_args_list, [call(worker, number, 9) for number in range(1, 10)])
            start.assert_not_called()
            worker.control.click.assert_called_once_with(1196, 195)
            self.assertEqual(worker.replay.index, 1)

    def test_mission_exploration_uses_burst_and_returns_through_story(self):
        frames = [self.home_with_end_marker(), load_fixture(STORY), load_fixture(QUEST),
                  load_fixture(STORY), load_fixture(QUEST)]
        with (self.worker(frames) as worker,
              patch.object(activity_utils, 'to_mission_task_info', return_value='activity_task-info') as select,
              patch.object(activity_utils, 'check_sweep_availability', side_effect=['no-pass'] + ['sss'] * 12),
              patch.object(activity_utils, 'start_mission') as start):
            # One battle and all completion states are simulated; tab transitions are real frames.
            self.assertTrue(explore_activity_mission.implement(worker))
            start.assert_called_once_with(worker, 'burst')
            self.assertEqual(select.call_args_list,
                             [call(worker, 1, 12)] + [call(worker, number, 12) for number in range(1, 13)])
            self.assertEqual(worker.control.click.call_args_list,
                             [call(1196, 195), call(1200, 91), call(936, 89), call(1200, 91)])
            self.assertEqual(worker.replay.index, 4)

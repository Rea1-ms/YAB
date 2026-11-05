"""Offline regressions for current and waiting task display snapshots."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from core.scheduler import Scheduler


class SchedulerDisplayTests(unittest.TestCase):
    def setUp(self):
        output = Path(__file__).resolve().parents[2] / 'develop_tools' / 'out'
        output.mkdir(parents=True, exist_ok=True)
        self.scratch = Path(tempfile.mkdtemp(prefix='scheduler-display-', dir=output))
        events = [
            {'func_name': func, 'event_name': name, 'enabled': True,
             'priority': priority, 'interval': 3600, 'next_tick': 0,
             'daily_reset': [], 'disabled_time_range': [], 'pre_task': [], 'post_task': []}
            for priority, (func, name) in enumerate(
                [('first', '任务甲'), ('second', '任务乙'), ('third', '任务乙')])
        ]
        (self.scratch / 'event.json').write_text(
            json.dumps(events, ensure_ascii=False), encoding='utf-8')
        self.signal = Mock()
        self.scheduler = Scheduler(self.signal, str(self.scratch))

    def test_repeated_heartbeats_keep_one_snapshot_and_exclude_current_task(self):
        for _ in range(3):
            self.assertEqual(self.scheduler.heartbeat()['current_task'], 'first')
            self.assertEqual(self.signal.emit.call_args.args[0], ['任务甲', '任务乙', '任务乙'])
            self.assertEqual(self.scheduler.getWaitingTaskList(), ['任务乙', '任务乙'])

    def test_finished_tasks_disappear_from_display_and_idle_queue_is_empty(self):
        for func, waiting in (('first', ['任务乙', '任务乙']),
                              ('second', ['任务乙']), ('third', [])):
            self.assertEqual(self.scheduler.heartbeat()['current_task'], func)
            self.assertEqual(self.scheduler.getWaitingTaskList(), waiting)
            self.scheduler.systole(func, next_time=3600)
        self.assertIsNone(self.scheduler.heartbeat())
        self.assertEqual(self.scheduler.getWaitingTaskList(), [])
        self.assertEqual(self.signal.emit.call_args.args[0], ['暂无任务'])


if __name__ == '__main__':
    unittest.main()

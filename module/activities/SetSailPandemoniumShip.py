"""真琴夏日活动：故事、任务和扫荡，没有独立挑战页。"""  # noqa: N999 - 与配置和素材目录保持同名。

from module.activities.activity_utils import (
    activity_sweep,
    explore_activity_mission,
    explore_activity_story,
)


def sweep(self):
    return activity_sweep(self)


def explore_story(self):
    return explore_activity_story(self)


def explore_mission(self):
    return explore_activity_mission(self)


def explore_challenge(self):
    self.logger.info("本期活动没有独立挑战关卡，跳过推挑战。")
    return True

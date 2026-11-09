"""Registered screenshots, replay clocks and diagnostics for offline tests."""

import hashlib
import json
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).with_name('fixtures')
MANIFEST = FIXTURES / 'manifest.json'
_diagnostics = ContextVar('offline_diagnostics', default=None)


def fixture_registry():
    data = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if (not isinstance(data, dict) or data.get('version') != 1
            or not isinstance(data.get('fixtures'), dict) or not data['fixtures']):
        raise ValueError('截图清单为空或版本不支持')
    return data['fixtures']


def fixture_path(name, metadata):
    relative = Path(metadata['path'])
    path = (FIXTURES / relative).resolve()
    if (relative.is_absolute() or '..' in relative.parts
            or not path.is_relative_to(FIXTURES.resolve()) or path.suffix != '.png'):
        raise ValueError(f'截图路径无效：{name}')
    return path


def _read_fixture(name, metadata):
    path = fixture_path(name, metadata)
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != metadata['sha256']:
        raise ValueError(f'截图校验值不一致：{name}')
    frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None or list(frame.shape[1::-1]) != metadata['size']:
        raise ValueError(f'截图损坏或尺寸不一致：{name}')
    return frame


def validate_fixtures():
    registry = fixture_registry()
    paths = set()
    for name, metadata in registry.items():
        if not isinstance(metadata, dict):
            raise ValueError(f'截图登记无效：{name}')  # noqa: TRY004 - Invalid JSON content, not a caller type error.
        if not isinstance(metadata.get('path'), str) or not metadata['path']:
            raise ValueError(f'截图缺少相对路径：{name}')
        digest = metadata.get('sha256')
        size = metadata.get('size')
        users = metadata.get('used_by')
        if (not isinstance(digest, str) or len(digest) != 64
                or any(char not in '0123456789abcdef' for char in digest)
                or not isinstance(size, list) or len(size) != 2
                or any(type(value) is not int or value <= 0 for value in size)
                or not isinstance(users, list) or not users
                or any(not isinstance(value, str) or not value for value in users)
                or len(users) != len(set(users))):
            raise ValueError(f'截图校验信息或用例登记无效：{name}')
        path = fixture_path(name, metadata)
        if path in paths:
            raise ValueError(f'重复的截图路径：{name}')
        paths.add(path)
        if (not metadata.get('scene') or not metadata.get('server') or not metadata.get('used_by')
                or metadata.get('kind') not in ('capture_crop', 'redacted_capture')):
            raise ValueError(f'截图登记不完整：{name}')
        _read_fixture(name, metadata)
    return registry


def load_fixture(name):
    key = name.removesuffix('.png')
    registry = fixture_registry()
    if key not in registry:
        raise ValueError(f'截图未登记：{name}')
    frame = _read_fixture(key, registry[key])
    state = _diagnostics.get()
    if state is not None and key not in state['fixtures']:
        state['fixtures'].append(key)
    return frame


def begin_case():
    state = {'fixtures': [], 'frames': [], 'actions': [], 'checks': [], 'last_image': None}
    return state, _diagnostics.set(state)


def end_case(token):
    _diagnostics.reset(token)


def record_frame(frame, *, index=None, at=None):
    state = _diagnostics.get()
    if state is not None:
        state['last_image'] = frame
        state['frames'].append({'index': index, 'time': at, 'size': list(frame.shape[1::-1])})


def record_action(action):
    state = _diagnostics.get()
    if state is not None:
        state['actions'].append(action)


class ReplayClock:
    """Advance production time explicitly, without waiting on the wall clock."""

    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FrameReplay:
    """Observations advance on screenshots; clicks never imply success."""

    def __init__(self, frames, clock, step=0.5):
        if not frames:
            raise ValueError('回放至少需要一帧')
        self.frames, self.clock, self.step = frames, clock, step
        self.index = -1
        self.actions = []
        # The caller may reuse the prepared first frame. A fresh screenshot
        # still consumes the observation sequence, independently of clicks.
        self.image = frames[0]
        record_frame(self.image, index=-1, at=clock.time())

    def screenshot(self):
        self.index += 1
        if self.index >= len(self.frames):
            raise AssertionError('回放帧已用完，流程仍未确认结束')
        self.clock.sleep(self.step)
        self.image = self.frames[self.index]
        record_frame(self.image, index=self.index, at=self.clock.time())
        return self.image

    def click(self, x, y, **kwargs):
        action = {'type': 'click', 'position': [x, y], 'frame': self.index,
                  'time': self.clock.time(), 'options': kwargs}
        self.actions.append(action)
        record_action(action)


@contextmanager
def recognition_diagnostics():
    from core import image, position

    original = image.compare_image

    def compare(worker, name, *args, **kwargs):
        matched = original(worker, name, *args, **kwargs)
        state = _diagnostics.get()
        if state is not None:
            prefix, separator, key = name.rpartition('_')
            area = (position.image_x_y_range.get(worker.identifier, {}).get(prefix, {}).get(key)
                    if separator else None)
            state['checks'].append({'feature': name, 'matched': bool(matched), 'area': area})
            del state['checks'][:-100]
            state['last_image'] = worker.latest_img_array
        return matched

    with patch.object(image, 'compare_image', compare):
        yield


@contextmanager
def offline_guard():
    # Import the production entry first to retain its normal module order.
    # Only object.__new__ and explicit fake workers are allowed in this suite.
    import uiautomator2
    from adbutils import AdbClient

    from core.Baas_thread import Baas_thread
    from core.config.config_set import ConfigSet
    from core.device.connection import Connection
    from core.device.Control import Control
    from core.device.Screenshot import Screenshot

    def reject(*_args, **_kwargs):
        raise AssertionError('离线测试不允许连接真实设备或读取账号配置')

    with ExitStack() as stack:
        for cls in (Baas_thread, ConfigSet, Connection, Control, Screenshot):
            stack.enter_context(patch.object(cls, '__init__', reject))
        for name in ('connect', 'device', 'device_list', 'iter_device', '_connect'):
            if hasattr(AdbClient, name):
                stack.enter_context(patch.object(AdbClient, name, reject))
        stack.enter_context(patch.object(uiautomator2, 'connect', reject))
        yield

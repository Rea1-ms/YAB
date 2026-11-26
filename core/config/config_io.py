"""Read and safely replace persistent profile configuration files."""

import json
import os
from datetime import datetime, timezone
from math import isfinite
from threading import RLock
from uuid import uuid4

from core.config.default_config import EVENT_DEFAULT_CONFIG

PROFILE_SCHEMA_VERSION = 1
_EVENT_DEFAULTS = json.loads(EVENT_DEFAULT_CONFIG)
KNOWN_EVENTS = frozenset(event['func_name'] for event in _EVENT_DEFAULTS)
EVENT_SETTINGS = frozenset(_EVENT_DEFAULTS[0]) - {'func_name'}
config_lock = RLock()


class ConfigFileError(ValueError):
    pass


def _reject_constant(value):
    raise ValueError(f'非法的配置数值：{value}')


def _read_finite_float(value):
    number = float(value)
    if not isfinite(number):
        _reject_constant(value)
    return number


def read_json(path, expected_type):
    try:
        original = path.read_bytes()
        data = json.loads(original.decode('utf-8-sig'), parse_constant=_reject_constant, parse_float=_read_finite_float)
    except FileNotFoundError:
        raise
    except (OSError, ValueError, RecursionError) as error:
        raise ConfigFileError(f'无法读取配置文件 {path}。请检查文件，或从备份恢复。') from error
    if not isinstance(data, expected_type):
        raise ConfigFileError(f'配置文件结构不兼容：{path}。请检查文件，或从备份恢复。')
    return data, original


def schema_version(path, data):
    version = data.get('schemaVersion', 0)
    if type(version) is not int or version < 0:
        raise ConfigFileError(f'配置结构版本无效：{path}。请检查文件，或从备份恢复。')
    if version > PROFILE_SCHEMA_VERSION:
        raise ConfigFileError(f'配置由更新版本的程序创建：{path}。请升级程序，或在独立目录恢复旧版备份。')
    return version


def read_main_config(path):
    data, original = read_json(path, dict)
    return data, original, schema_version(path, data)


def read_events(path):
    events, original = read_json(path, list)
    names = set()
    for event in events:
        name = event.get('func_name') if isinstance(event, dict) else None
        if not isinstance(name, str) or not name or name in names:
            raise ConfigFileError(f'调度配置中的任务标识无效或重复：{path}。请检查文件，或从备份恢复。')
        names.add(name)
    return events, original


def _is_hms(value):
    return isinstance(value, list) and len(value) == 3 and all(type(part) is int for part in value)


def validate_event_settings(path, event):
    def valid(key, check):
        if not check(event.get(key)):
            name = event['func_name']
            raise ConfigFileError(f'调度字段 {name}.{key} 的结构不兼容：{path}。请检查文件，或从备份恢复。')

    valid('event_name', lambda value: isinstance(value, str))
    valid('enabled', lambda value: type(value) is bool)
    for key in ('priority', 'interval', 'next_tick'):
        valid(key, lambda value: type(value) is int or (type(value) is float and isfinite(value)))
    valid('daily_reset', lambda value: isinstance(value, list) and all(
        _is_hms(entry) and all(0 <= part <= limit for part, limit in zip(entry, (23, 59, 59)))
        for entry in value))
    valid('disabled_time_range', lambda value: isinstance(value, list) and all(
        isinstance(entry, list) and len(entry) == 2 and all(_is_hms(boundary) for boundary in entry)
        for entry in value))
    for key in ('pre_task', 'post_task'):
        valid(key, lambda value: isinstance(value, list) and all(isinstance(task, str) for task in value))


def _replace_bytes(path, content):
    pending = path.with_name(f'.{path.name}.{uuid4().hex}.tmp')
    try:
        with pending.open('xb') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        pending.replace(path)
    except OSError as error:
        raise ConfigFileError(f'无法安全写入配置文件 {path}：{error}') from error


def replace_json(path, data, *, indent):
    try:
        content = json.dumps(data, ensure_ascii=False, indent=indent, allow_nan=False) + '\n'
        encoded = content.encode('utf-8')
    except (TypeError, ValueError, RecursionError) as error:
        raise ConfigFileError(f'配置中包含无法保存的值：{path}。') from error
    _replace_bytes(path, encoded)


def backup_migration(path, original, version):
    directory = path.parent / 'backups'
    directory.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    target = directory / f'{path.stem}.v{version}.{stamp}.{uuid4().hex}.bak.json'
    _replace_bytes(target, original)


def update_events(path, edit):
    """Apply an edit to the latest task data shared by the scheduler and web UI."""
    with config_lock:
        main = path.with_name('config.json')
        if main.exists():
            read_main_config(main)
        events, _ = read_events(path)
        for event in events:
            if event['func_name'] in KNOWN_EVENTS:
                validate_event_settings(path, event)
        if edit(events):
            replace_json(path, events, indent=2)
        return events

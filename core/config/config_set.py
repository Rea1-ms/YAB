import json
import os
from copy import deepcopy
from dataclasses import asdict, fields
from pathlib import Path

from core.config.config_io import (
    PROFILE_SCHEMA_VERSION,
    ConfigFileError,
    backup_migration,
    config_lock,
    read_main_config,
    replace_json,
    schema_version,
)
from core.config.default_config import DEFAULT_CONFIG
from core.config.generated_static_config import StaticConfig
from core.config.generated_user_config import Config
from core.config.shop_config import (
    migrate_tactical_shop_list,
    remap_tactical_shop_list,
    validate_tactical_shop_list,
)
from core.paths import profiles_dir

CONFIG_FIELDS = {field.name for field in fields(Config)}
CONFIG_DEFAULTS = json.loads(DEFAULT_CONFIG)
CREATE_PRIORITY_FIELDS = ('createPriority_phase1', 'createPriority_phase2', 'createPriority_phase3')


def fill_defaults(data, defaults):
    for key, value in defaults.items():
        if key not in data:
            data[key] = deepcopy(value)
        elif isinstance(data[key], dict) and isinstance(value, dict):
            fill_defaults(data[key], value)


def migrate_v0_to_v1(data):
    from core.push_config import legacy_channels

    channels = data['push_onepush'] if 'push_onepush' in data else legacy_channels(data)
    return {**data, 'push_onepush': channels, 'schemaVersion': 1}


MIGRATIONS = (migrate_v0_to_v1,)


def prepare_config(path, original, prices):
    version = schema_version(path, original)
    data = deepcopy(original)
    for migrate in MIGRATIONS[version:PROFILE_SCHEMA_VERSION]:
        data = migrate(data)

    # Older templates used strings while the task and web editor saved lists.
    for key in CREATE_PRIORITY_FIELDS:
        value = data.get(key)
        if isinstance(value, str):
            data[key] = [value] if value else []
    fill_defaults(data, CONFIG_DEFAULTS)
    for key, default in CONFIG_DEFAULTS.items():
        value = data[key]
        if (isinstance(default, (list, dict)) or isinstance(value, (list, dict))) and type(value) is not type(default):
            raise ConfigFileError(f'配置字段 {key} 的结构不兼容：{path}。请检查文件，或从备份恢复。')

    lesson_key = 'lesson_each_region_object_priority'
    data[lesson_key].extend(CONFIG_DEFAULTS[lesson_key][len(data[lesson_key]):])
    server = ConfigSet.get_server_mode(data['server'])
    if server is None:
        raise ConfigFileError(f'无法识别配置中的游戏服务器：{path}。请检查文件，或使用支持该服务器的版本。')
    if server in prices:
        data['TacticalChallengeShopList'] = migrate_tactical_shop_list(data['TacticalChallengeShopList'],
                                                                        server, prices[server])
    return data


def _apply_edits(data, before, after):
    for key, value in after.items():
        previous = before.get(key)
        if isinstance(previous, dict) and isinstance(value, dict) and isinstance(data.get(key), dict):
            _apply_edits(data[key], previous, value)
        elif key not in before or value != previous or type(value) is not type(previous):
            data[key] = value


class ConfigSet:
    static_config: StaticConfig = None

    def __init__(self, config_dir):
        # change happens in self.config ( dataclass )
        # save change : dataclass --> dict --> json_str
        super().__init__()
        if ConfigSet.static_config is None:
            ConfigSet._init_static_config()
        self.config: Config
        self.config_dir = None
        if os.path.exists(profiles_dir() / config_dir / 'config.json'):
            self.config_dir = os.path.abspath(profiles_dir() / config_dir)
        elif os.path.exists(f'{config_dir}/config.json'):  # absolute path
            self.config_dir = config_dir
        else:
            raise FileNotFoundError(f'{profiles_dir() / config_dir / "config.json"} not found')
        self._path = Path(self.config_dir) / 'config.json'
        self._init_config()
        self.window = None
        self.main_thread = None
        self.signals = {}

    @staticmethod
    def _init_static_config():
        with open(profiles_dir() / 'static.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
            ConfigSet.static_config = StaticConfig(**data)

    def _init_config(self):
        with config_lock:
            original, _, _ = read_main_config(self._path)
        data = prepare_config(self._path, original, self.static_config.tactical_challenge_shop_price_list)
        self.config = Config(**{key: data[key] for key in CONFIG_FIELDS})
        self._loaded = asdict(self.config)
        self.server_mode = self.get_server_mode(self.config.server)

    @staticmethod
    def get_server_mode(server):
        if server in ['官服', 'B服']:
            return 'CN'
        if server in ['国际服', '国际服青少年', '韩国ONE', 'Steam国际服']:
            return 'Global'
        if server in ['日服', '日服PC端']:
            return 'JP'

    def get(self, key, default=None):
        self._init_config()
        return getattr(self.config, key, default)

    def has(self, key):
        self._init_config()
        return hasattr(self.config, key)

    def set(self, key, value):
        self.set_fields({key: value})

    def set_fields(self, values):
        with config_lock:
            self._init_config()
            for key, value in values.items():
                if key not in CONFIG_FIELDS:
                    raise ValueError(f'未知的配置字段：{key}')
                self._set(key, value)
            self.save()

    def _set(self, key, value):
        prices = self.static_config.tactical_challenge_shop_price_list
        if key == 'push_onepush':
            from core.push_config import validate_channels
            value = validate_channels(value)
        elif key == 'TacticalChallengeShopList':
            validate_tactical_shop_list(value, prices[self.server_mode])
        elif key == 'server':
            server = self.get_server_mode(value)
            if server is None:
                raise ValueError('未知的游戏服务器')
            if server != self.server_mode:
                self.config.TacticalChallengeShopList = remap_tactical_shop_list(
                    self.config.TacticalChallengeShopList, prices[self.server_mode], prices[server]
                )
                self.server_mode = server
        setattr(self.config, key, value)

    def update(self, key, value):
        self.set(key, value)

    def save(self):
        with config_lock:
            original, raw, version = read_main_config(self._path)
            prices = self.static_config.tactical_challenge_shop_price_list
            data = prepare_config(self._path, original, prices)
            edited = asdict(self.config)
            migrated = data != original
            _apply_edits(data, self._loaded, edited)
            # Check the result before copying or replacing any file.
            data = prepare_config(self._path, data, prices)
            if data != original:
                if migrated:
                    backup_migration(self._path, raw, version)
                replace_json(self._path, data, indent=4)
            self._loaded = edited

    def __getitem__(self, item: str):
        return self.get(item)

    def add_signal(self, key, signal):
        self.signals[key] = signal

    def get_signal(self, key):
        return self.signals.get(key)

    def get_signals(self):
        return self.signals

    def set_window(self, window):
        self.window = window

    def get_window(self):
        return self.window

    def set_main_thread(self, thread):
        self.main_thread = thread

    def get_main_thread(self):
        return self.main_thread

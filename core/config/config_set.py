import json
import os
from core.config.generated_user_config import Config
from core.config.generated_static_config import StaticConfig
from core.config.shop_config import (
    migrate_tactical_shop_list, remap_tactical_shop_list, validate_tactical_shop_list,
)
from dataclasses import asdict


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
        if os.path.exists(f'config/{config_dir}/config.json'):  # relative path
            self.config_dir = os.path.abspath(f'config/{config_dir}')
        elif os.path.exists(f'{config_dir}/config.json'):  # absolute path
            self.config_dir = config_dir
        else:
            raise FileNotFoundError(f'config/{config_dir}/config.json not found')
        self.server_mode = 'CN'
        self._init_config()
        self.window = None
        self.main_thread = None
        self.signals = {}

    @staticmethod
    def _init_static_config():
        with open('config/static.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
            ConfigSet.static_config = StaticConfig(**data)

    def _init_config(self):
        with open(os.path.join(self.config_dir, "config.json"), 'r', encoding='utf-8') as f:
            self.config = Config(**json.load(f))
        self.server_mode = self.get_server_mode(self.config.server)
        prices = self.static_config.tactical_challenge_shop_price_list
        if self.server_mode in prices:
            self.config.TacticalChallengeShopList = migrate_tactical_shop_list(
                self.config.TacticalChallengeShopList, self.server_mode, prices[self.server_mode]
            )

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
        self._init_config()
        prices = self.static_config.tactical_challenge_shop_price_list
        if key == 'TacticalChallengeShopList':
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
        self.save()

    def update(self, key, value):
        self.set(key, value)

    def save(self):
        data = asdict(self.config)
        with open(os.path.join(self.config_dir, "config.json"), 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)

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

    def update_create_quantity_entry(self):
        dft = self.static_config.create_item_order[self.server_mode]["basic"]
        dft_list = [item for sublist in dft.values() for item in sublist]
        pop_list = []
        for key in self.config.create_item_holding_quantity:
            if key not in dft_list:
                pop_list.append(key)
        for key in pop_list:
            self.config.create_item_holding_quantity.pop(key)

        for entry in dft_list:
            if entry not in self.config.create_item_holding_quantity:
                self.config.create_item_holding_quantity[entry] = -1
        self.save()

"""Writable paths shared by source and installed launches."""

import os
from pathlib import Path


def profiles_dir():
    root = os.environ.get('YAB_CONFIG_DIR')
    return Path(root) / 'profiles' if root else Path('config')


def data_path(name):
    path = Path(os.environ.get('YAB_DATA_DIR') or '.') / name
    path.parent.mkdir(parents=True, exist_ok=True)
    return path

"""Identify source distributions without relying on a frozen executable."""

import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent.parent


def is_distribution(root=None):
    root = Path(root) if root is not None else ROOT
    return getattr(sys, 'frozen', False) or (root / 'distribution.json').is_file()


def distribution_version():
    try:
        return str(json.loads((ROOT / 'distribution.json').read_text(encoding='utf-8'))['version'])
    except (OSError, ValueError, KeyError, TypeError):
        return None

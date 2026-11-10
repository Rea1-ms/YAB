"""Identify source distributions without relying on a frozen executable."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def project_metadata():
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib
    try:
        with (ROOT / 'pyproject.toml').open('rb') as stream:
            return tomllib.load(stream)
    except (OSError, ValueError):
        return {}


def is_distribution(root=None):
    root = Path(root) if root is not None else ROOT
    return getattr(sys, 'frozen', False) or (root / 'distribution.json').is_file()


def distribution_version():
    try:
        return str(json.loads((ROOT / 'distribution.json').read_text(encoding='utf-8'))['version'])
    except (OSError, ValueError, KeyError, TypeError):
        return None

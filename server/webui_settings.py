"""Application-wide listener preferences, shared by source and desktop launches."""

import ipaddress
import json
import os
from pathlib import Path


DEFAULTS = {'host': '127.0.0.1', 'port': 22267}


def settings_path():
    return Path(os.environ.get('YAB_CONFIG_DIR') or 'config') / 'webui.json'


def validate_settings(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULTS):
        raise ValueError('网页服务设置需要包含监听地址和端口')
    host, port = value['host'], value['port']
    if not isinstance(host, str):
        raise ValueError('监听地址不合法')
    if host != 'localhost':
        try:
            ipaddress.ip_address(host)
        except ValueError:
            raise ValueError('监听地址需要填写 IP 地址或 localhost') from None
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('端口需要填写 1 至 65535 的整数')
    return {'host': host, 'port': port}


def load_settings():
    path = settings_path()
    if not path.exists():
        return DEFAULTS.copy()
    try:
        return validate_settings(json.loads(path.read_text(encoding='utf-8')))
    except (OSError, ValueError) as error:
        raise ValueError(f'无法读取网页服务设置 {path}：{error}') from error


def save_settings(value):
    from server.security import is_loopback

    settings = validate_settings(value)
    if not is_loopback(settings['host']) and not os.environ.get('BAAS_WEBUI_TOKEN'):
        raise ValueError('局域网访问需要先通过 BAAS_WEBUI_TOKEN 环境变量设置访问密码')
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write to a separate file first, preserving existing preferences on failure.
    import uuid
    pending = path.with_name(f'.webui-{uuid.uuid4().hex}.json')
    pending.write_text(json.dumps(settings, indent=2) + '\n', encoding='utf-8')
    pending.replace(path)
    return settings

import json
from copy import deepcopy

from core.config import default_config
from core.config.config_io import (
    ConfigFileError,
    backup_migration,
    config_lock,
    read_events,
    read_main_config,
    replace_json,
    validate_event_settings,
)
from core.config.config_set import ConfigSet, fill_defaults, prepare_config
from core.paths import profiles_dir


def check_static_config():
    path = profiles_dir() / 'static.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    replace_json(path, json.loads(default_config.STATIC_DEFAULT_CONFIG), indent=2)


def check_switch_config(dir_path='./default_config'):
    path = profiles_dir() / dir_path / 'switch.json'
    replace_json(path, json.loads(default_config.SWITCH_DEFAULT_CONFIG), indent=2)


def _prepare_user_config(path, static, *, add_create_entries=False):
    try:
        original, raw, version = read_main_config(path)
    except FileNotFoundError:
        original, raw, version = {}, None, 0
    data = prepare_config(path, original, static['tactical_challenge_shop_price_list'])
    if add_create_entries:
        server = ConfigSet.get_server_mode(data['server'])
        for group in static['create_item_order'][server]['basic'].values():
            for item in group:
                data['create_item_holding_quantity'].setdefault(item, -1)
    return original, raw, version, data


def check_and_update_user_config(dir_path='./default_config'):
    path = profiles_dir() / dir_path / 'config.json'
    static = json.loads(default_config.STATIC_DEFAULT_CONFIG)
    with config_lock:
        original, raw, version, data = _prepare_user_config(path, static)
        if data != original:
            if raw is not None:
                backup_migration(path, raw, version)
            replace_json(path, data, indent=4)


def _prepare_events(path, server, enable_state):
    defaults = json.loads(default_config.EVENT_DEFAULT_CONFIG)
    if server != 'CN':
        for event in defaults:
            for reset in event['daily_reset']:
                reset[0] -= 1
    try:
        original, raw = read_events(path)
    except FileNotFoundError:
        return None, None, defaults

    events = deepcopy(original)
    by_name = {event['func_name']: event for event in events}
    for index, entry in enumerate(defaults):
        name = entry['func_name']
        if name in by_name:
            fill_defaults(by_name[name], entry)
            validate_event_settings(path, by_name[name])
        else:
            if enable_state in ('on', 'off'):
                entry['enabled'] = enable_state == 'on'
            events.insert(index, entry)
    return original, raw, events


def check_event_config(dir_path='./default_config', user_config=None):
    path = profiles_dir() / dir_path / 'event.json'
    with config_lock:
        _, _, version = read_main_config(path.with_name('config.json'))
        previous, raw, data = _prepare_events(path, user_config.server_mode, user_config.config.new_event_enable_state)
        if data != previous:
            if raw is not None:
                backup_migration(path, raw, version)
            replace_json(path, data, indent=2)


def _check_profile(name, static):
    folder = profiles_dir() / name
    folder.mkdir(parents=True, exist_ok=True)
    main = folder / 'config.json'
    schedule = folder / 'event.json'

    original, config_bytes, version, config = _prepare_user_config(main, static, add_create_entries=True)
    server = ConfigSet.get_server_mode(config['server'])
    old_events, event_bytes, events = _prepare_events(schedule, server, config['new_event_enable_state'])

    # Validate both files and finish the backups before replacing either file.
    if config != original and config_bytes is not None:
        backup_migration(main, config_bytes, version)
    if events != old_events and event_bytes is not None:
        backup_migration(schedule, event_bytes, version)
    # Publish the profile version after the schedule has been saved.
    if events != old_events:
        replace_json(schedule, events, indent=2)
    if config != original:
        replace_json(main, config, indent=4)
    check_switch_config(name)


def check_config(dir_path, *, on_error=None):
    names = [dir_path] if isinstance(dir_path, str) else dir_path
    static = json.loads(default_config.STATIC_DEFAULT_CONFIG)
    with config_lock:
        check_static_config()
        for name in names:
            try:
                _check_profile(name, static)
            except (ConfigFileError, OSError) as error:
                if on_error is None:
                    raise
                on_error(name, str(error))

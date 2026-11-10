import json
import os
import shutil
import threading
import time
from dataclasses import asdict
from pathlib import Path

from server.hub import Hub


def config_path(name, require_exists=True):
    if (not isinstance(name, str) or not name or name != name.strip()
            or name in ('.', '..') or name.endswith('.')
            or any(c in name for c in '/\\:') or any(ord(c) < 32 for c in name)):
        raise ValueError('配置目录名称不合法')
    base = Path('config').resolve()
    path = (base / name).resolve()
    if path.parent != base:
        raise ValueError('配置目录必须位于配置根目录内')
    if require_exists and (not (path / 'config.json').is_file() or name not in os.listdir(base)):
        raise ValueError(f'Config not found: {name}')
    return path


class _Signal:
    """Adapter so core code can call signal.emit(...) with plain functions."""

    def __init__(self, fn):
        self._fn = fn

    def emit(self, *args):
        self._fn(*args)


def scan_configs():
    res = []
    base = './config'
    if not os.path.exists(base):
        return res
    for name in sorted(os.listdir(base)):
        path = os.path.join(base, name)
        if os.path.isdir(path) and os.path.exists(os.path.join(path, 'config.json')):
            try:
                with open(os.path.join(path, 'config.json'), encoding='utf-8') as f:
                    display = json.load(f).get('name', name)
            except Exception:
                display = name
            res.append({'dir': name, 'name': display})
    return res


def get_version():
    from core.distribution import distribution_version, project_metadata
    bundled = distribution_version()
    if bundled:
        return bundled
    return str(project_metadata().get('project', {}).get('version', 'dev'))


class BaasService:
    """
    Glue between the web server and BAAS core: holds the OCR `Main` singleton
    and one Baas_thread per running config, wiring their signals into hub
    topics (Log / State).
    """

    def __init__(self, hub: Hub):
        self.hub = hub
        self.main = None
        self.ocr_ready = False
        self.ocr_error = None
        self.threads = {}  # config -> Baas_thread
        self.workers = {}  # config -> threading.Thread
        self.states = {}  # config -> dict(running, button, current, waiting)
        self._control_lock = threading.RLock()
        self._stop_events = {}
        self.listener = None

    def webui_get(self):
        from server.webui_settings import load_settings
        return {'saved': load_settings(), 'active': self.listener,
                'port_override': bool(os.environ.get('YAB_DESKTOP_PORT_OVERRIDE'))}

    def webui_save(self, params):
        from server.webui_settings import save_settings
        save_settings(params)
        return self.webui_get()

    # ---------- state helpers ----------

    def get_state(self, config):
        config_path(config, require_exists=False)
        with self._control_lock:
            return self.states.setdefault(
                config, {'running': False, 'button': '启动', 'current': '', 'waiting': []})

    def _set_state(self, config, **patch):
        with self._control_lock:
            state = self.get_state(config)
            state.update(patch)
            self.hub.push(f'State:{config}', 'full', dict(state))

    def _busy(self, config):
        worker = self.workers.get(config)
        return (worker is not None and worker.is_alive()) or self.get_state(config)['running']

    # ---------- ocr ----------

    def init_ocr(self, ocr_needed):
        def _init():
            try:
                from main import Main
                self.main = Main(ocr_needed=ocr_needed)
                if not self.main.ready:
                    raise RuntimeError(self.main.init_error or '识别服务初始化失败')
                self.ocr_ready = True
                self.ocr_error = None
                self.hub.push('Meta', 'set', {'ocr_ready': True, 'ocr_error': None})
                self.hub.push_full('ConfigScan')
                if os.environ.get('YAB_DESKTOP_RECOVERY') != '1':
                    self._autostart()
            except Exception as e:
                self.ocr_ready = False
                self.ocr_error = str(e)
                self.hub.log('__server__', 3, f'OCR init failed: {e}')
                self.hub.push('Meta', 'set', {'ocr_ready': False, 'ocr_error': str(e)})

        threading.Thread(target=_init, daemon=True, name='baas-ocr-init').start()

    def _autostart(self):
        for item in scan_configs():
            try:
                from core.config.config_set import ConfigSet
                if ConfigSet(item['dir']).get('autostart'):
                    self.start(item['dir'])
            except Exception as e:
                self.hub.log('__server__', 3, f'autostart {item["dir"]} failed: {e}')

    # ---------- log / signal callbacks ----------

    def _on_log(self, config, level, message):
        self.hub.log(config, level, message)

    def _on_button(self, config, state):
        with self._control_lock:
            worker = self.workers.get(config)
            if state == '启动' and worker is not None and worker.is_alive():
                self._set_state(config, running=True, button='停止', current='正在停止')
            else:
                self._set_state(config, button=state, running=(state == '停止'))

    def _on_update(self, config, tasks):
        tasks = list(tasks)
        if tasks == ['暂无任务']:
            self._set_state(config, current='暂无任务', waiting=[])
        else:
            self._set_state(config, current=tasks[0] if tasks else '', waiting=tasks[1:])

    def _on_exit(self, config, code):
        self._on_button(config, '启动')
        self.hub.log(config, 1, '-- YAB Exited --')

    # ---------- script control ----------

    def _create_thread(self, config):
        from core.config.config_set import ConfigSet
        # a fresh Baas_thread per start, same as the old GUI (unique hash name)
        name = f'{config}-{time.time_ns()}'
        return self.main.get_thread(
            ConfigSet(config), name=name,
            logger_signal=_Signal(lambda level, msg: self._on_log(config, level, msg)),
            button_signal=_Signal(lambda state: self._on_button(config, state)),
            update_signal=_Signal(lambda tasks: self._on_update(config, tasks)),
            exit_signal=_Signal(lambda code: self._on_exit(config, code)),
        )

    def start(self, config):
        return self._launch(config)

    def _launch(self, config, task=None):
        config_path(config)
        if not self.ocr_ready:
            raise RuntimeError('OCR 尚未初始化完成，请稍候')
        with self._control_lock:
            if self._busy(config):
                if task is not None:
                    raise ValueError('配置正在运行，请先停止')
                return
            t = self._create_thread(config)
            cancelled = threading.Event()
            worker = threading.Thread(target=self._run, args=(config, t, task, cancelled),
                                      daemon=True, name=f'baas-{config}')
            self.threads[config] = t
            self.workers[config] = worker
            self._stop_events[config] = cancelled
            self._set_state(config, running=True, button='停止', current='初始化', waiting=[])
            try:
                worker.start()
            except Exception:
                self._set_state(config, running=False, button='启动', current='', waiting=[])
                self.threads.pop(config, None)
                self.workers.pop(config, None)
                self._stop_events.pop(config, None)
                raise

    def _run(self, config, t, task, cancelled):
        try:
            if cancelled.is_set():
                return
            if not t.init_all_data():
                self.hub.log(config, 3, 'Initialization Failed')
                return
            if cancelled.is_set():
                t.send('stop')
                return
            if task is None:
                self.hub.log(config, 1, 'Starting YAB...')
                t.send('start')
            else:
                self._set_state(config, current=task)
                self.hub.log(config, 1, f'Run task: {task}')
                t.send('solve', task)
        except Exception as e:
            self.hub.log(config, 3, f'Script error: {e}')
        finally:
            with self._control_lock:
                if self.threads.get(config) is t:
                    self._set_state(config, running=False, button='启动', current='', waiting=[])
                    self.threads.pop(config, None)
                    self._stop_events.pop(config, None)

    def stop(self, config):
        config_path(config)
        with self._control_lock:
            t = self.threads.get(config)
            cancelled = self._stop_events.get(config)
            if cancelled is not None:
                cancelled.set()
            if t is not None:
                t.send('stop')
                self._set_state(config, running=True, button='停止', current='正在停止')
                self.hub.log(config, 1, 'Stop requested by user')

    def run_task(self, config, task):
        return self._launch(config, task)

    # ---------- config management ----------

    def push_test(self, config, params):
        from core.push_config import validate_channels
        from core.push_onepush import send_channel
        config_path(config)
        channel = params.get('channel')
        validate_channels([channel], require_complete=True)
        return send_channel(channel, 'YAB 通知测试', '收到这条消息，说明推送渠道配置成功。')

    def config_set(self, config, params):
        from core.config.config_set import ConfigSet
        if params['key'] == 'name':
            return self.config_rename(config, params['value'])
        config_path(config)
        ConfigSet(config).set(params['key'], params['value'])
        self.hub.push_full(f'ConfigArg:{config}')
        if params['key'] == 'server':
            self.hub.push_full(f'Panels:{config}')

    def config_add(self, name):
        from core.config.config_init import check_config
        from core.config.config_set import ConfigSet
        path = config_path(name, require_exists=False)
        if path.exists():
            raise ValueError(f'Config already exists: {name}')
        check_config([name])
        ConfigSet(name).set('name', name)
        self.hub.push_full('ConfigScan')

    def config_delete(self, name):
        path = config_path(name)
        with self._control_lock:
            if name.casefold() == 'default_config':
                raise ValueError('default_config 不允许删除')
            if self._busy(name):
                raise ValueError('配置正在运行，请先停止')
            shutil.rmtree(path)
            self.hub.push_full('ConfigScan')

    def config_rename(self, config, new_name):
        from core.config.config_set import ConfigSet
        config_path(config)
        if not isinstance(new_name, str) or not new_name.strip():
            raise ValueError('名称不能为空')
        ConfigSet(config).set('name', new_name.strip())
        self.hub.push_full('ConfigScan')
        self.hub.push_full(f'ConfigArg:{config}')

    # ---------- topic providers ----------

    ASSET_KEYS = ['ap', 'creditpoints', 'pyroxene', 'tactical_challenge_coin', 'bounty_coin', '_pass']

    def provide_assets(self, config):
        from core.config.config_set import ConfigSet
        config_path(config)
        cs = ConfigSet(config)
        res = {key: cs.get(key) for key in self.ASSET_KEYS}
        holding = cs.get('create_item_holding_quantity') or {}
        res['Keystone-Piece'] = holding.get('Keystone-Piece')
        res['Keystone'] = holding.get('Keystone')
        return res

    def set_sweep(self, config, params):
        """Set mainlinePriority / hardPriority and refresh the companion
        unfinished task lists, replicating the old GUI panel logic."""
        from core.config.config_set import ConfigSet
        from module.explore_tasks.sweep_task import read_task
        config_path(config)
        key = params.get('key')
        if key not in ('mainlinePriority', 'hardPriority'):
            raise ValueError('invalid sweep key')
        is_normal = key == 'mainlinePriority'
        raw = str(params.get('value', ''))
        content = raw.replace(' ', '').replace('，', ',')
        cs = ConfigSet(config)
        companion = 'unfinished_normal_tasks' if is_normal else 'unfinished_hard_tasks'
        if content == '':
            cs.set(key, '')
            cs.set(companion, [])
        else:
            tasks = [list(read_task(item, is_normal)) for item in content.split(',')]
            cs.set(key, content)
            cs.set(companion, tasks)
        self.hub.push_full(f'ConfigArg:{config}')
        return content

    def provide_config_arg(self, config):
        from core.config.config_set import ConfigSet
        config_path(config)
        return asdict(ConfigSet(config).config)

    def provide_event_config(self, config):
        from core.config.config_set import ConfigSet
        config_path(config)
        path = os.path.join(ConfigSet(config).config_dir, 'event.json')
        with open(path, encoding='utf-8') as f:
            return json.load(f)

    def save_event_config(self, config, events):
        from core.config.config_set import ConfigSet
        config_path(config)
        path = os.path.join(ConfigSet(config).config_dir, 'event.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(events, f, ensure_ascii=False, indent=2)

    # ---------- event rpcs ----------

    def event_set(self, config, params):
        func_name = params['func_name']
        patch = params.get('patch', {})
        events = self.provide_event_config(config)
        for event in events:
            if event['func_name'] == func_name:
                event.update(patch)
                break
        self.save_event_config(config, events)
        self.hub.push_full(f'EventConfig:{config}')

    def event_enable_all(self, config, params):
        enabled = bool(params.get('enabled', True))
        events = self.provide_event_config(config)
        for event in events:
            event['enabled'] = enabled
        self.save_event_config(config, events)
        self.hub.push_full(f'EventConfig:{config}')

    def event_refresh_all(self, config, _params):
        events = self.provide_event_config(config)
        now = int(time.time())
        for event in events:
            event['next_tick'] = now
        self.save_event_config(config, events)
        self.hub.push_full(f'EventConfig:{config}')

    # ---------- panels / assets ----------

    def provide_panels(self, config):
        from server.panels import resolve_schema, switch_cards
        from core.config.config_set import ConfigSet
        config_path(config)
        cs = ConfigSet(config)
        return {'panels': resolve_schema(cs), 'cards': switch_cards()}

    # ---------- update settings (setup.toml) ----------

    UPDATE_KEYS = {
        'mirrorc_cdk': 'General.mirrorc_cdk',
        'repo_url_http': 'URLs.REPO_URL_HTTP',
        'get_remote_sha_method': 'General.get_remote_sha_method',
    }

    REPO_URL_CHECK_UPDATE_METHOD = {
        'https://github.com/pur1fying/blue_archive_auto_script.git': 'github',
        'https://gitee.com/pur1fy/blue_archive_auto_script.git': 'gitee',
        'https://gitcode.com/m0_74686738/blue_archive_auto_script.git': 'gitcode',
        'https://e.coding.net/g-jbio0266/baas/blue_archive_auto_script.git': 'tencent_c_coding',
    }

    def _toml_config(self):
        path = './setup.toml'
        if not os.path.exists(path):
            return None
        from deploy.installer.toml_config import TOML_Config
        return TOML_Config(path)

    def update_get(self, _params):
        from core.distribution import project_metadata

        cfg = self._toml_config()
        info = {
            'has_setup_toml': cfg is not None,
            'current_version': get_version(),
            'upstream': project_metadata().get('tool', {}).get('yab', {}).get('upstream'),
        }
        if cfg is not None:
            info.update({
                'mirrorc_cdk': cfg.get('General.mirrorc_cdk', ''),
                'repo_url_http': cfg.get('URLs.REPO_URL_HTTP', ''),
                'get_remote_sha_method': cfg.get('General.get_remote_sha_method', ''),
            })
        return info

    def update_save(self, params):
        cfg = self._toml_config()
        if cfg is None:
            raise ValueError('未找到 setup.toml（非完整发行包环境，更新设置不可用）')
        patch = params.get('patch', {})
        for name, value in patch.items():
            key = self.UPDATE_KEYS.get(name)
            if key is None:
                raise ValueError(f'不允许修改: {name}')
            cfg.set_and_save(key, value)
        return self.update_get({})

    def cdk_test(self, params):
        cdk = str(params.get('cdk', '')).strip()
        try:
            from deploy.installer.mirrorc_update.mirrorc_updater import MirrorC_Updater
            inst = MirrorC_Updater(app='BAAS_repo', current_version='')
            ret = inst.get_latest_version(cdk=cdk, timeout=3.0)
            return {'ok': True, 'data': ret}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def sha_test(self, params):
        url = params.get('repo_url_http', '')
        method_name = self.REPO_URL_CHECK_UPDATE_METHOD.get(url)
        if not method_name:
            raise ValueError('未知仓库地址，请先选择 Git 更新仓库')
        from deploy.installer.const import get_remote_sha_methods, GetShaMethod
        conf = next((c for c in get_remote_sha_methods if c['name'] == method_name), None)
        if conf is None:
            raise ValueError(f'未找到更新方式配置: {method_name}')
        t0 = time.time()
        if conf['method'] == GetShaMethod.GITHUB_API:
            ok, sha = self._github_api_get_latest_sha(conf)
        else:
            ok, sha = self._dulwich_get_latest_sha(conf)
        return {'ok': ok, 'sha': sha, 'elapsed': round(time.time() - t0, 2)}

    @staticmethod
    def _github_api_get_latest_sha(conf):
        try:
            import requests
            url = f"https://api.github.com/repos/{conf['owner']}/{conf['repo']}/branches/{conf['branch']}"
            resp = requests.get(url, timeout=3.0)
            resp.raise_for_status()
            return True, resp.json().get('commit', {}).get('sha')
        except Exception as e:
            return False, str(e)

    @staticmethod
    def _dulwich_get_latest_sha(conf):
        try:
            import binascii
            import dulwich.porcelain
            remote_refs = dulwich.porcelain.ls_remote(conf['url'])
            for ref_name, sha in remote_refs.items():
                name = ref_name.decode('utf-8') if isinstance(ref_name, bytes) else ref_name
                if name.endswith('refs/heads/' + str(conf['branch'])) or name == str(conf['branch']):
                    raw = sha[:20] if len(sha) > 20 else sha
                    return True, binascii.hexlify(raw).decode('utf-8')
            return False, f'branch not found: {conf["branch"]}'
        except Exception as e:
            return False, str(e)

    # ---------- help documents ----------

    def help_list(self, _params):
        base = Path('src/descriptions')
        if not base.is_dir():
            return []
        res = []
        for lang in sorted(os.listdir(base)):
            lang_dir = base / lang
            if lang_dir.is_dir():
                res.append({'lang': lang,
                            'files': sorted(f for f in os.listdir(lang_dir) if f.endswith('.html'))})
        return res

    def help_content(self, params):
        base = Path('src/descriptions').resolve()
        lang = str(params.get('lang', ''))
        name = str(params.get('name', ''))
        if not lang or not name or '/' in name or '\\' in name or '..' in name or not name.endswith('.html'):
            raise ValueError('非法的文档路径')
        path = (base / lang / name).resolve()
        if path.parent != (base / lang).resolve() or not path.is_file():
            raise ValueError('文档不存在')
        return {'lang': lang, 'name': name, 'html': path.read_text(encoding='utf-8', errors='replace')}

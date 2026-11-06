import asyncio
import json
import os

from starlette.applications import Starlette
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware import Middleware
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from server.hub import Hub
from server.security import WebAccess
from server.service import BaasService, get_version, scan_configs

THEN_OPTIONS = ['无动作', '退出 Baas', '退出 模拟器', '退出 Baas 和 模拟器', '关闭游戏', '关机']
SERVER_OPTIONS = ['官服', 'B服', '国际服', '国际服青少年', '韩国ONE', '日服', '日服PC端', 'Steam国际服']
MULTI_EMULATOR_NAMES = {
    'mumu': 'MuMu模拟器',
    'mumu_global': 'MuMu模拟器全球版',
    'bluestacks_nxt_cn': '蓝叠模拟器',
    'bluestacks_nxt': '蓝叠国际版',
}


def build_meta(service: BaasService):
    from core.config import default_config
    from core.config.config_set import ConfigSet
    if ConfigSet.static_config is None:
        ConfigSet._init_static_config()
    static_config = ConfigSet.static_config
    return {
        'version': get_version(),
        'ocr_ready': service.ocr_ready,
        'ocr_error': service.ocr_error,
        'screenshot_methods': static_config.screenshot_methods,
        'control_methods': static_config.control_methods,
        'then_options': THEN_OPTIONS,
        'servers': SERVER_OPTIONS,
        'multi_emulator_names': MULTI_EMULATOR_NAMES,
        'event_names': {
            e['func_name']: e['event_name']
            for e in json.loads(default_config.EVENT_DEFAULT_CONFIG)
        },
    }


class WebsocketServer:
    def __init__(self, hub: Hub):
        self.hub = hub

    async def endpoint(self, websocket: WebSocket):
        await websocket.accept()
        self.hub.connect(websocket)
        try:
            await self.hub.subscribe(websocket, 'Meta')
            await self.hub.subscribe(websocket, 'ConfigScan')
            while True:
                msg = await websocket.receive_json()
                await self.hub.handle(websocket, msg)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            self.hub.disconnect(websocket)


def bootstrap_configs(service: BaasService):
    """Same startup migration as the old Qt window: rewrite static.json /
    switch.json defaults, merge config.json / event.json with new keys."""
    from core.config.config_init import check_config
    dirs = [item['dir'] for item in scan_configs()]
    if not dirs:
        dirs = ['default_config']
    check_config(dirs)
    return dirs


def derive_ocr_needed():
    servers = set()
    from core.config.config_set import ConfigSet
    for item in scan_configs():
        try:
            servers.add(ConfigSet(item['dir']).config.server)
        except Exception:
            continue
    ocr_needed = ['en-us']
    if servers & {'官服', 'B服'}:
        ocr_needed.append('zh-cn')
    if '日服' in servers:
        ocr_needed.append('ja-jp')
    return ocr_needed


def register_topics(hub: Hub, service: BaasService):
    hub.register_provider('Meta', lambda _config: build_meta(service))
    hub.register_provider('ConfigScan', lambda _config: scan_configs())
    hub.register_provider('State', service.get_state)
    hub.register_provider('ConfigArg', service.provide_config_arg)
    hub.register_provider('EventConfig', service.provide_event_config)
    hub.register_provider('Panels', service.provide_panels)

    hub.register_rpc('State', 'start', lambda config, _params: service.start(config))
    hub.register_rpc('State', 'stop', lambda config, _params: service.stop(config))
    hub.register_rpc('State', 'run_task', lambda config, params: service.run_task(config, params['task']))

    hub.register_rpc('ConfigScan', 'add', lambda _config, params: service.config_add(params['name']))
    hub.register_rpc('ConfigScan', 'delete', lambda _config, params: service.config_delete(params['name']))
    hub.register_rpc('ConfigScan', 'rename',
                     lambda _config, params: service.config_rename(params['config'], params['name']))

    hub.register_rpc('ConfigArg', 'set', service.config_set)
    hub.register_rpc('ConfigArg', 'set_sweep', service.set_sweep)
    hub.register_rpc('Assets', 'get', lambda config, _params: service.provide_assets(config))

    hub.register_rpc('EventConfig', 'set_event', service.event_set)
    hub.register_rpc('EventConfig', 'enable_all', service.event_enable_all)
    hub.register_rpc('EventConfig', 'refresh_all', service.event_refresh_all)

    hub.register_rpc('Meta', 'autosearch_adb', lambda _config, _params: _autosearch_adb())
    hub.register_rpc('Meta', 'connect_adb', lambda _config, params: _connect_adb(params))
    hub.register_rpc('Meta', 'update_get', lambda _config, params: service.update_get(params))
    hub.register_rpc('Meta', 'update_save', lambda _config, params: service.update_save(params))
    hub.register_rpc('Meta', 'cdk_test', lambda _config, params: service.cdk_test(params))
    hub.register_rpc('Meta', 'sha_test', lambda _config, params: service.sha_test(params))
    hub.register_rpc('Meta', 'help_list', lambda _config, params: service.help_list(params))
    hub.register_rpc('Meta', 'help_content', lambda _config, params: service.help_content(params))
    hub.register_rpc('Meta', 'webui_get', lambda _config, _params: service.webui_get())
    hub.register_rpc('Meta', 'webui_save', lambda _config, params: service.webui_save(params))


def _autosearch_adb():
    from core.device.adb_devices import connected_devices
    return connected_devices()


def _connect_adb(params):
    from core.device.adb_devices import connect_device
    return connect_device(params.get('host', ''), params.get('port', ''))


class SPAStaticFiles(StaticFiles):
    """Serve the built SPA: extensionless 404 paths fall back to index.html,
    everything is served with no-cache to avoid stale bundles."""

    async def get_response(self, path: str, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as e:
            # newer starlette raises instead of returning a 404 response
            if e.status_code != 404 or '.' in path:
                raise
            response = await super().get_response('index.html', scope)
        if response.status_code == 404 and '.' not in path:
            response = await super().get_response('index.html', scope)
        response.headers['Cache-Control'] = 'no-cache'
        return response


def create_app(serve_webapp=True, access_token=None, listener=None) -> Starlette:
    hub = Hub()
    service = BaasService(hub)
    service.listener = listener
    register_topics(hub, service)
    ws_server = WebsocketServer(hub)

    async def health(_request):
        return JSONResponse({'status': 'ok', 'version': get_version(),
                             'ocr_ready': service.ocr_ready, 'ocr_error': service.ocr_error})

    routes = [
        WebSocketRoute('/api/ws', ws_server.endpoint),
        Route('/api/health', health),
    ]

    dist = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'webapp', 'dist')
    if serve_webapp:
        if not os.path.isfile(os.path.join(dist, 'index.html')):
            raise RuntimeError('缺少网页资源，请通过 python -m server 启动；仅开发后端时使用 --api-only')
        routes.append(Mount('/', SPAStaticFiles(directory=dist, html=True), name='webapp'))

    async def lifespan(_app):
        hub.set_loop(asyncio.get_running_loop())
        bootstrap_configs(service)
        service.hub.push_full('ConfigScan')
        service.init_ocr(derive_ocr_needed())
        yield

    token = os.environ.get('BAAS_WEBUI_TOKEN', '') if access_token is None else access_token
    return Starlette(routes=routes, lifespan=lifespan,
                     middleware=[Middleware(WebAccess, token=token)])

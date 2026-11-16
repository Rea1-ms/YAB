"""Isolated recovery UI backend; tasks are simulated and no device is used."""

import json
import os
import socket
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import uvicorn
from starlette.routing import Mount

from core.config.default_config import DEFAULT_CONFIG
from server.app import SPAStaticFiles, create_app


def main():
    scratch = Path(sys.argv[1]).resolve()
    os.chdir(scratch)
    for name in ('account', 'second'):
        path = scratch / f'config/{name}/config.json'
        if not path.exists():
            path.parent.mkdir(parents=True)
            data = json.loads(DEFAULT_CONFIG)
            data.update(name=name, autostart=True)
            path.write_text(json.dumps(data), encoding='utf-8')

    def start(service, config):
        file = scratch / 'starts.json'
        starts = json.loads(file.read_text()) if file.exists() else []
        starts.append(config)
        file.write_text(json.dumps(starts))
        service._set_state(config, running=True, button='停止', current='模拟任务', waiting=[])
        service.hub.log(config, 1, '模拟任务已启动')

    with socket.socket() as listener, \
            patch('main.Main', return_value=SimpleNamespace(ready=True)), \
            patch('server.service.BaasService.start', start):
        listener.bind(('127.0.0.1', int(sys.argv[2])))
        listener.listen()
        port = listener.getsockname()[1]
        app = create_app(serve_webapp=False, access_token='', listener={'host': '127.0.0.1', 'port': port})
        app.routes.append(Mount('/', SPAStaticFiles(directory=os.environ['YAB_RECOVERY_TEST_FRONTEND'], html=True)))
        print(f'RECOVERY_UI_URL=http://127.0.0.1:{port}', flush=True)
        uvicorn.Server(uvicorn.Config(app, log_level='error')).run(sockets=[listener])


if __name__ == '__main__':
    main()

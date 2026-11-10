"""Isolated backend for the notification form regression; no external delivery."""

import json
import os
import socket
import sys
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import uvicorn
from starlette.routing import Mount

from core.config.default_config import DEFAULT_CONFIG
from server.app import SPAStaticFiles, create_app


def main():
    scratch = Path(sys.argv[1]).resolve()
    os.chdir(scratch)
    path = scratch / 'config/account/config.json'
    path.parent.mkdir(parents=True)
    data = json.loads(DEFAULT_CONFIG)
    del data['push_onepush']
    data.update(name='通知验证', push_telegram_bot_token='offline-ui-token',
                push_telegram_chat_id='-123', push_telegram_proxy='http://127.0.0.1:1080')
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    calls = []

    def deliver(method, _url, **_kwargs):
        calls.append({'method': method})
        (scratch / 'deliveries.json').write_text(json.dumps(calls), encoding='utf-8')
        response = Mock(status_code=200)
        response.json.return_value = {'code': 0, 'ok': True}
        return response

    with socket.socket() as listener, patch('server.service.BaasService.init_ocr'), \
            patch('requests.Session.request', side_effect=deliver):
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        app = create_app(serve_webapp=False, access_token='', listener={'host': '127.0.0.1', 'port': port})
        app.routes.append(Mount('/', SPAStaticFiles(directory=os.environ['YAB_PUSH_TEST_FRONTEND'], html=True)))
        print(f'PUSH_UI_URL=http://127.0.0.1:{port}', flush=True)
        uvicorn.Server(uvicorn.Config(app, log_level='error')).run(sockets=[listener])


if __name__ == '__main__':
    main()

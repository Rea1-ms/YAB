import argparse
import os

import uvicorn

from server.app import create_app
from server.frontend import ensure_frontend
from server.security import is_loopback


def main():
    parser = argparse.ArgumentParser(description='BAAS WebUI server')
    parser.add_argument('--host', default='127.0.0.1', help='listen host, default 127.0.0.1')
    parser.add_argument('--port', type=int, default=22267, help='listen port, default 22267')
    parser.add_argument('--open', action='store_true', help='open browser after start')
    parser.add_argument('--api-only', action='store_true', help='run backend only for frontend development')
    args = parser.parse_args()

    if not is_loopback(args.host) and not os.environ.get('BAAS_WEBUI_TOKEN'):
        parser.error('远程访问需要先设置 BAAS_WEBUI_TOKEN 环境变量作为访问密码')
    if not args.api_only:
        ensure_frontend()
    app = create_app(serve_webapp=not args.api_only)
    host = '127.0.0.1' if args.host == '0.0.0.0' else args.host
    if ':' in host:
        host = f'[{host}]'
    url = f'http://{host}:{args.port}'
    print(f'-- BAAS WebUI running at {url} --')
    if args.open:
        import threading
        import webbrowser
        opener = threading.Timer(1.5, lambda: webbrowser.open(url))
        opener.daemon = True
        opener.start()
    uvicorn.run(app, host=args.host, port=args.port, log_level='warning', use_colors=False)


if __name__ == '__main__':
    main()

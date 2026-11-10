import argparse
import os

import uvicorn

from server.app import create_app
from server.frontend import ensure_frontend
from server.security import is_loopback
from server.webui_settings import load_settings, validate_settings


def main():
    parser = argparse.ArgumentParser(description='YAB WebUI server')
    parser.add_argument('--host', help='override configured listen host, default 127.0.0.1')
    parser.add_argument('--port', type=int, help='override configured listen port, default 22267')
    parser.add_argument('--open', action='store_true', help='open browser after start')
    parser.add_argument('--api-only', action='store_true', help='run backend only for frontend development')
    args = parser.parse_args()
    try:
        settings = load_settings()
        settings.update({key: getattr(args, key) for key in ('host', 'port') if getattr(args, key) is not None})
        settings = validate_settings(settings)
    except ValueError as error:
        parser.error(str(error))
    args.host, args.port = settings['host'], settings['port']

    if not is_loopback(args.host) and not os.environ.get('BAAS_WEBUI_TOKEN'):
        parser.error('远程访问需要先设置 BAAS_WEBUI_TOKEN 环境变量作为访问密码')
    if not args.api_only:
        ensure_frontend()
    app = create_app(serve_webapp=not args.api_only, listener=settings)
    host = '127.0.0.1' if args.host == '0.0.0.0' else ('::1' if args.host == '::' else args.host)
    if ':' in host:
        host = f'[{host}]'
    url = f'http://{host}:{args.port}'
    print(f'-- YAB WebUI running at {url} --')
    if args.open:
        import threading
        import webbrowser
        opener = threading.Timer(1.5, lambda: webbrowser.open(url))
        opener.daemon = True
        opener.start()
    uvicorn.run(app, host=args.host, port=args.port, log_level='warning', use_colors=False)


if __name__ == '__main__':
    main()

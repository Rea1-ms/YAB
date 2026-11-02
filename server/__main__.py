import argparse

import uvicorn

from server.app import create_app


def main():
    parser = argparse.ArgumentParser(description='BAAS WebUI server')
    parser.add_argument('--host', default='127.0.0.1', help='listen host, default 127.0.0.1')
    parser.add_argument('--port', type=int, default=22267, help='listen port, default 22267')
    parser.add_argument('--open', action='store_true', help='open browser after start')
    args = parser.parse_args()

    app = create_app()
    url = f'http://{"127.0.0.1" if args.host == "0.0.0.0" else args.host}:{args.port}'
    print(f'-- BAAS WebUI running at {url} --')
    if args.open:
        import threading
        import webbrowser
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level='warning')


if __name__ == '__main__':
    main()

"""Check both the authenticated WebUI and OCR initialization."""

import json
import os
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen


def check_health(url='http://127.0.0.1:22267/api/health'):
    token = os.environ.get('BAAS_WEBUI_TOKEN')
    if not token:
        raise RuntimeError('未设置网页访问密码')
    request = Request(url, headers={'Authorization': f'Bearer {token}'})
    with urlopen(request, timeout=3) as response:
        status = json.load(response)
    if status.get('status') != 'ok' or status.get('ocr_ready') is not True or status.get('ocr_error'):
        raise RuntimeError(status.get('ocr_error') or '文字识别服务尚未就绪')


if __name__ == '__main__':
    try:
        check_health()
    except (OSError, URLError, ValueError, RuntimeError) as error:
        print(f'服务未就绪：{error}', file=sys.stderr)
        sys.exit(1)

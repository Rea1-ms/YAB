"""OnePush delivery with bounded requests and credential-safe result reporting."""

import smtplib
import ssl as tls
from copy import deepcopy

import onepush
import requests

from core.push_config import validate_channels

REQUEST_TIMEOUT = 10


def _replace_message(value, title, content):
    if isinstance(value, str):
        return value.replace('{{title}}', title).replace('{{content}}', content)
    if isinstance(value, dict):
        return {key: _replace_message(item, title, content) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_message(item, title, content) for item in value]
    return value


def _prepare_smtp(notifier):
    # The upstream SMTP constructor has no timeout. Keep this local to the instance.
    def prepare(host, user, password, port=0, ssl=None, starttls=False, **_kwargs):
        encrypted = port == 465 if ssl is None else ssl
        connection = smtplib.SMTP_SSL if encrypted else smtplib.SMTP
        options = {'timeout': REQUEST_TIMEOUT}
        if encrypted:
            options['context'] = tls.create_default_context()
        server = connection(host, port, **options)
        try:
            if starttls:
                server.starttls(context=tls.create_default_context())
            server.login(user=user, password=password)
        except Exception:
            server.close()
            raise
        notifier._server = server
    notifier._prepare_url = prepare


def _check_response(provider, response):
    if provider == 'smtp':
        if response != {}:
            raise ValueError('邮件接收方拒绝了消息')
        return
    if response is None or not 200 <= response.status_code < 300:
        raise ValueError('推送服务返回异常状态')
    # Some services return HTTP 200 even when authentication or delivery fails.
    try:
        payload = response.json()
    except ValueError:
        if provider != 'custom' and response.status_code != 204:
            raise ValueError('推送服务返回格式不正确') from None
        return
    if not isinstance(payload, dict):
        return
    if payload.get('ok') is False or payload.get('success') is False:
        raise ValueError('推送服务未接受消息')
    for key in ('errcode', 'code', 'retcode'):
        if key in payload and payload[key] not in (0, 200, '0', '200'):
            raise ValueError('推送服务未接受消息')


def send_channel(channel, title, content):
    """Return a safe result; never include the request URL or response text."""
    provider = channel.get('provider', '') if isinstance(channel, dict) else ''
    result = {'provider': provider if isinstance(provider, str) else '', 'success': False}
    try:
        validate_channels([channel], require_complete=True)
        if not channel['enabled']:
            return {**result, 'message': '该推送渠道已停用'}
        notifier = onepush.get_notifier(provider)
        params = deepcopy(channel['params'])
        params.update(title=title, content=content)
        proxy = channel.get('proxy', '').strip()
        proxies = params.pop('proxies', None)
        if proxy:
            proxies = {'http': proxy, 'https': proxy}
        if provider == 'telegram':
            # Accept both a bare hostname and the full legacy API URL (including HTTP).
            api = params.get('api_url') or 'https://api.telegram.org'
            params['api_url'] = (api if '://' in api else 'https://' + api).rstrip('/')
            notifier.base_url = '{}/bot{}/sendMessage'
        elif provider == 'lark':
            # These optional parameters have no defaults in OnePush 1.10.0.
            params.setdefault('keyword', '')
            params.setdefault('sign', '')
            params['content'] = f'{title}\n{content}'
        elif provider == 'wechatworkbot':
            # The upstream plain-text branch creates an empty message in 1.10.0.
            if not params.get('markdown'):
                def prepare_text(**_kwargs):
                    notifier.data = {'msgtype': 'text', 'text': {'content': f'{title}\n{content}'}}
                    return notifier.data
                notifier._prepare_data = prepare_text
        elif provider == 'custom':
            params['data'] = _replace_message(
                params.get('data', {'title': '{{title}}', 'desp': '{{content}}'}), title, content
            )
        elif provider == 'smtp':
            _prepare_smtp(notifier)

        with requests.Session() as session:
            def request(method, url, request_proxies=None, **kwargs):
                # Some providers omit proxies when calling request(). Apply it here too.
                kwargs['timeout'] = REQUEST_TIMEOUT
                kwargs['proxies'] = request_proxies if request_proxies is not None else proxies
                return session.request(method, url, **kwargs)
            notifier.request = request
            response = notifier.notify(**params)
            _check_response(provider, response)
        return {**result, 'success': True, 'message': '推送成功'}
    except Exception as error:  # noqa: BLE001 - third-party notification failures must not stop tasks
        # Exception strings and upstream debug logs can contain tokens and passwords.
        return {**result, 'message': f'推送失败（{type(error).__name__}），请检查参数、网络或服务状态'}


def send_channels(logger, channels, title, content):
    results = []
    for index, channel in enumerate(channels, 1):
        if isinstance(channel, dict) and channel.get('enabled') is False:
            continue
        result = send_channel(channel, title, content)
        message = f'推送渠道 {index}：{result["message"]}'
        (logger.info if result['success'] else logger.error)(message)
        results.append(result)
    return results

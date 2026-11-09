"""OnePush channel discovery, validation and legacy configuration migration."""

from copy import deepcopy

import onepush

MESSAGE_PARAMS = {'title', 'content'}
PROVIDER_LABELS = {
    'serverchan': 'Server 酱（旧版）', 'serverchanturbo': 'Server 酱',
    'lark': '飞书', 'wechatworkbot': '企业微信机器人',
    'wechatworkapp': '企业微信应用', 'telegram': 'Telegram（电报）',
    'dingtalk': '钉钉', 'smtp': '电子邮件', 'custom': '自定义接口',
    'bark': 'Bark', 'discord': 'Discord', 'pushplus': 'PushPlus',
    'pushdeer': 'PushDeer', 'qmsg': 'Qmsg', 'gocqhttp': 'QQ（go-cqhttp）',
    'gotify': 'Gotify', 'ntfy': 'ntfy', 'wpush': 'WPush',
}


def provider_catalog():
    result = []
    for name in onepush.all_providers():
        notifier = onepush.get_notifier(name)
        params = notifier.params
        result.append({
            'id': name, 'label': PROVIDER_LABELS.get(name, name),
            'required': [key for key in params['required'] if key not in MESSAGE_PARAMS],
            'optional': [key for key in params['optional'] if key not in MESSAGE_PARAMS],
        })
    return result


def legacy_channels(data):
    """Only used when the new key is absent; an explicitly empty list stays empty."""
    channels = []

    def add(provider, params, proxy=''):
        channels.append({'provider': provider, 'enabled': True, 'params': params, 'proxy': proxy})

    if data.get('push_json'):
        add('custom', {'url': data['push_json'], 'datatype': 'json'})
    if data.get('push_serverchan'):
        add('serverchanturbo', {'sctkey': data['push_serverchan']})
    if data.get('push_feishu'):
        add('lark', {'webhook': data['push_feishu']})
    if data.get('push_wecom'):
        add('wechatworkbot', {'key': data['push_wecom']})
    # Preserve partial Telegram credentials so the user can complete them in settings.
    if data.get('push_telegram_bot_token') or data.get('push_telegram_chat_id'):
        params = {'token': data.get('push_telegram_bot_token', ''),
                  'userid': data.get('push_telegram_chat_id', '')}
        if data.get('push_telegram_api'):
            params['api_url'] = data['push_telegram_api']
        add('telegram', params, data.get('push_telegram_proxy', ''))
    return channels


def validate_channels(channels, *, require_complete=False):
    if not isinstance(channels, list) or len(channels) > 32:
        raise ValueError('推送渠道需要是列表，最多 32 个')
    known = {item['id']: item for item in provider_catalog()}
    for index, channel in enumerate(channels, 1):
        prefix = f'推送渠道 {index}：'
        if (not isinstance(channel, dict) or not isinstance(channel.get('provider'), str)
                or channel['provider'] not in known):
            raise ValueError(prefix + '请选择有效的推送渠道')
        if not isinstance(channel.get('enabled'), bool) or not isinstance(channel.get('params'), dict):
            raise ValueError(prefix + '推送参数格式不正确')  # noqa: TRY004 - invalid user configuration
        if not isinstance(channel.get('proxy', ''), str):
            raise ValueError(prefix + '代理地址需要是文本')  # noqa: TRY004 - invalid user configuration
        if require_complete and channel['enabled']:
            for key in known[channel['provider']]['required']:
                if channel['params'].get(key) in (None, ''):
                    raise ValueError(prefix + f'请填写 {key}')
    return deepcopy(channels)

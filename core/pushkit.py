import requests
import json
from core.utils import Logger
from core.config.generated_user_config import Config
from core.push_config import legacy_channels
from core.push_onepush import send_channels
serverchan_url = 'https://sctapi.ftqq.com/{KEY}.send'

headers = {
    "Content-type": "application/json"
}


def push(logger: Logger, config: Config, error: str = None):
    data = {}
    if error and config.push_after_error:
        data['title'] = "YAB Error"
        data['desp'] = error

    if not error and config.push_after_completion:
        data['title'] = "YAB Completed"
        data['desp'] = "all activities finished"

    if data:
        channels = getattr(config, 'push_onepush', None)
        if channels is None:
            channels = legacy_channels(vars(config))
        return send_channels(logger, channels, data['title'], data['desp'])
    return []


def push_json(logger: Logger, url: str, data: dict):
    try:
        if requests.post(url, data=json.dumps(data), headers=headers).status_code == 200:
            logger.info("push success")
        else:
            raise Exception("push failed")
    except Exception as e:
        logger.error(e)


def push_serverchan(logger: Logger, url: str, data: dict):
    try:
        if requests.post(url, data=json.dumps(data), headers=headers).status_code == 200:
            logger.info("[ Server Chan ] push success")
        else:
            raise Exception("[ Server chan ] push failed")
    except Exception as e:
        logger.error("[ Server Chan ] push error : " + e.__str__())


def push_feishu(logger: Logger, webhook_url: str, data: dict):
    feishu_data = {
        "msg_type": "text",
        "content": {
            "text": f"{data['title']}\n{data['desp']}"
        }
    }
    try:
        resp = requests.post(
            webhook_url,
            json=feishu_data,
            headers={"Content-Type": "application/json"}
        )
        if resp.status_code == 200:
            result = resp.json()
            if result.get("code") == 0:
                logger.info("[ Feishu ] push success")
            else:
                logger.error(f"[ Feishu ] push failed: {result.get('msg', 'unknown error')}")
        else:
            logger.error(f"[ Feishu ] push HTTP error: {resp.status_code}")
    except Exception as e:
        logger.error(f"[ Feishu ] push exception: {type(e).__name__}; webhook=**")


def push_wecom(logger: Logger, webhook_url: str, data: dict):
    wecom_data = {
        "msgtype": "text",
        "text": {
            "content": f"{data['title']}\n{data['desp']}"
        }
    }
    try:
        resp = requests.post(
            webhook_url,
            json=wecom_data,
            headers={"Content-Type": "application/json"}
        )
        if resp.status_code == 200:
            result = resp.json()
            if result.get("errcode") == 0:
                logger.info("[ WeCom ] push success")
            else:
                logger.error(f"[ WeCom ] push failed: {result.get('errmsg', 'unknown error')}")
        else:
            logger.error(f"[ WeCom ] push HTTP error: {resp.status_code}")
    except Exception as e:
        logger.error(f"[ WeCom ] push exception: {type(e).__name__}; webhook=**")

def push_telegram(
    logger: Logger,
    bot_token: str,
    chat_id: str,
    data: dict,
    proxy: str = '',
    api: str = '',
    timeout: int = 30
):
    telegram_api = api.rstrip('/') if api else 'https://api.telegram.org'
    url = f'{telegram_api}/bot{bot_token}/sendMessage'

    telegram_data = {
        'chat_id': chat_id,
        'text': f"{data['title']}\n{data['desp']}"
    }

    proxies = None

    if proxy:
        proxies = {
            'http': proxy,
            'https': proxy
        }

    try:
        resp = requests.post(
            url,
            json=telegram_data,
            proxies=proxies,
            timeout=timeout
        )

        try:
            result = resp.json()
        except ValueError:
            # e.g. proxy returns an HTML error page with HTTP 200
            logger.error(
                f"[ Telegram ] push HTTP error: {resp.status_code}, "
                f"response is not JSON, check proxy or API address"
            )
            return

        if result.get('ok'):
            logger.info("[ Telegram ] push success")
        else:
            logger.error(
                f"[ Telegram ] push failed: "
                f"{result.get('description', f'HTTP {resp.status_code}')}"
            )

    except Exception as e:
        # do not log the url: it contains the bot token
        logger.error(
            f"[ Telegram ] push exception: "
            f"{type(e).__name__}"
        )

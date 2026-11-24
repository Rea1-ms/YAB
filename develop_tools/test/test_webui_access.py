"""Access regressions without opening a browser or connecting a device."""

import secrets
import json
import os
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from starlette.responses import JSONResponse

from server.security import COOKIE_NAME, WebAccess


async def endpoint(scope, receive, send):
    if scope['type'] == 'websocket':
        await send({'type': 'websocket.accept'})
        await send({'type': 'websocket.close', 'code': 1000})
    else:
        await JSONResponse({'ok': True})(scope, receive, send)


class AccessTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, app, path='/api/health', method='GET', headers=None,
                      client='127.0.0.1', websocket=False, body=b''):
        values = {'host': '127.0.0.1:22267', **(headers or {})}
        scope = {'type': 'websocket' if websocket else 'http', 'path': path,
                 'method': method, 'http_version': '1.1', 'scheme': 'http',
                 'headers': [(k.encode(), v.encode()) for k, v in values.items()],
                 'client': (client, 1000), 'server': ('127.0.0.1', 22267),
                 'query_string': b'', 'root_path': ''}
        messages = []

        async def receive():
            return {'type': 'http.request', 'body': body, 'more_body': False}

        async def send(message):
            messages.append(message)

        await app(scope, receive, send)
        return messages

    def status(self, messages):
        return messages[0].get('status')

    async def test_local_websocket_checks_origin_and_effective_port(self):
        app = WebAccess(endpoint)
        for origin in ('https://untrusted.invalid', 'null', 'http://127.0.0.1:22268'):
            messages = await self.request(app, websocket=True, headers={'origin': origin})
            self.assertEqual(messages[0]['type'], 'websocket.close')
            self.assertEqual(messages[0]['code'], 1008)
        messages = await self.request(app, websocket=True, headers={'origin': 'http://127.0.0.1:22267'})
        self.assertEqual(messages[0]['type'], 'websocket.accept')

    async def test_native_local_clients_can_connect_without_origin(self):
        messages = await self.request(WebAccess(endpoint), websocket=True)
        self.assertEqual(messages[0]['type'], 'websocket.accept')

    async def test_local_frontend_dev_proxy_origin_is_allowed(self):
        messages = await self.request(WebAccess(endpoint), websocket=True,
                                      headers={'host': 'localhost:5173', 'origin': 'http://localhost:5173'})
        self.assertEqual(messages[0]['type'], 'websocket.accept')

    async def test_remote_clients_without_password_and_rebound_hosts_are_rejected(self):
        app = WebAccess(endpoint)
        messages = await self.request(app, client='192.0.2.1')
        self.assertEqual(self.status(messages), 403)
        messages = await self.request(app, websocket=True, client='192.0.2.1')
        self.assertEqual(messages[0]['type'], 'websocket.close')
        messages = await self.request(app, headers={'host': 'untrusted.invalid:22267'})
        self.assertEqual(self.status(messages), 403)

    async def test_login_session_grants_http_and_websocket_access(self):
        token = secrets.token_urlsafe(24)
        app = WebAccess(endpoint, token=token)
        messages = await self.request(app)
        self.assertEqual(self.status(messages), 401)
        messages = await self.request(app, path='/')
        self.assertEqual(self.status(messages), 307)
        messages = await self.request(app, path='/login', client='192.0.2.1')
        self.assertEqual(self.status(messages), 200)
        messages = await self.request(app, path='/login', method='POST',
                                      headers={'origin': 'http://127.0.0.1:22267'},
                                      body=urlencode({'token': token}).encode())
        self.assertEqual(self.status(messages), 303)
        cookie = dict(messages[0]['headers'])[b'set-cookie'].decode()
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=strict', cookie)
        self.assertNotIn(token, cookie)
        self.assertTrue(cookie.startswith(COOKIE_NAME + '='))
        headers = {'cookie': cookie.split(';', 1)[0], 'origin': 'http://127.0.0.1:22267'}
        messages = await self.request(app, headers=headers, client='192.0.2.1')
        self.assertEqual(self.status(messages), 200)
        messages = await self.request(app, headers=headers, websocket=True, client='192.0.2.1')
        self.assertEqual(messages[0]['type'], 'websocket.accept')
        headers['origin'] = 'https://untrusted.invalid'
        messages = await self.request(app, headers=headers, websocket=True)
        self.assertEqual(messages[0]['type'], 'websocket.close')

    async def test_wrong_password_and_cross_origin_login_are_rejected(self):
        app = WebAccess(endpoint, token=secrets.token_urlsafe(24))
        messages = await self.request(app, path='/login', method='POST', body=b'token=wrong')
        self.assertEqual(self.status(messages), 401)
        self.assertNotIn(b'set-cookie', dict(messages[0]['headers']))
        messages = await self.request(app, path='/login', method='POST',
                                      headers={'origin': 'https://untrusted.invalid'}, body=b'token=wrong')
        self.assertEqual(self.status(messages), 403)

    async def test_native_remote_access_requires_bearer_or_session(self):
        token = secrets.token_urlsafe(24)
        app = WebAccess(endpoint, token=token)
        messages = await self.request(app, websocket=True, client='192.0.2.1')
        self.assertEqual(messages[0]['type'], 'websocket.close')
        messages = await self.request(app, websocket=True, client='192.0.2.1',
                                      headers={'authorization': 'Bearer ' + token})
        self.assertEqual(messages[0]['type'], 'websocket.accept')


class DesktopUpdateAccessTests(unittest.IsolatedAsyncioTestCase):
    request = AccessTests.request
    status = AccessTests.status

    async def test_update_requires_private_token_as_well_as_web_access(self):
        from server.app import create_app
        with patch.dict(os.environ, {'YAB_DESKTOP_UPDATE_TOKEN': 'private-fixture-token'}):
            app = create_app(serve_webapp=False, access_token='web-fixture-token')
        url = '/api/desktop-update'
        body = json.dumps({'action': 'prepare'}).encode()
        headers = {'x-yab-desktop-token': 'private-fixture-token'}
        self.assertEqual(self.status(await self.request(app, url, 'POST', headers, body=body)), 401)
        headers = {'authorization': 'Bearer web-fixture-token'}
        self.assertEqual(self.status(await self.request(app, url, 'POST', headers, body=body)), 403)
        headers['x-yab-desktop-token'] = 'wrong'
        self.assertEqual(self.status(await self.request(app, url, 'POST', headers, body=body)), 403)
        headers['x-yab-desktop-token'] = 'private-fixture-token'
        for action, pending, ready in (('prepare', True, True), ('status', True, True), ('cancel', False, False)):
            messages = await self.request(app, url, 'POST', headers, body=json.dumps({'action': action}).encode())
            self.assertEqual(self.status(messages), 200)
            self.assertEqual(json.loads(messages[1]['body']), {'pending': pending, 'ready': ready, 'running': []})
        for bad in (b'not-json', b'[]', b'{"action":"install"}'):
            self.assertEqual(self.status(await self.request(app, url, 'POST', headers, body=bad)), 400)

    async def test_source_server_has_no_update_control_without_private_token(self):
        from server.app import create_app
        with patch.dict(os.environ, {'YAB_DESKTOP_UPDATE_TOKEN': ''}):
            app = create_app(serve_webapp=False, access_token='')
        messages = await self.request(app, '/api/desktop-update', 'POST',
                                      {'x-yab-desktop-token': 'invented'}, body=b'{"action":"prepare"}')
        self.assertEqual(self.status(messages), 403)


if __name__ == '__main__':
    unittest.main()

import asyncio
import json
import threading
import time
from collections import deque


class Hub:
    """
    WebSocket topic hub, Alasio-style protocol:

    client -> server : {"t": topic, "o": "sub"|"unsub"|"rpc", "f": fn, "v": params, "i": rpc_id}
    server -> client : {"t": topic, "o": "full"|"add"|"set", "v": value}
                       {"t": topic, "i": rpc_id, "e": error|null, "r": result}

    Topic naming: global topics are plain names (`Meta`, `ConfigScan`),
    per-config topics are suffixed with the config dir (`Log:<config>`,
    `State:<config>`, `ConfigArg:<config>`, `EventConfig:<config>`).

    push()/log() are thread-safe: events are queued and flushed on the
    asyncio loop in batches.
    """

    LOG_BUFFER = 500

    def __init__(self):
        self.loop = None
        self.subs = {}  # ws -> set(topic)
        self.topics = {}  # topic -> set(ws)
        self.providers = {}  # prefix -> callable(config|None) -> full value
        self.rpc_handlers = {}  # (prefix, fn) -> callable(config|None, params) -> result
        self.log_cache = {}  # config -> deque[entry]
        self._pending = []
        self._pending_lock = threading.Lock()
        self._flush_scheduled = False

    # ---------- registration ----------

    def set_loop(self, loop):
        self.loop = loop

    def register_provider(self, prefix, fn):
        self.providers[prefix] = fn

    def register_rpc(self, prefix, fn, handler):
        self.rpc_handlers[(prefix, fn)] = handler

    # ---------- push (thread-safe) ----------

    def push(self, topic, op, value):
        with self._pending_lock:
            self._pending.append((topic, op, value))
            if self._flush_scheduled:
                return
            self._flush_scheduled = True
        self.loop.call_soon_threadsafe(self._flush)

    def push_full(self, topic):
        prefix, _, arg = topic.partition(':')
        provider = self.providers.get(prefix)
        if provider is None:
            return
        value = provider(arg or None)
        self.push(topic, 'full', value)

    def log(self, config, level, message):
        entry = {'l': level, 'm': message, 't': time.time()}
        cache = self.log_cache.setdefault(config, deque(maxlen=self.LOG_BUFFER))
        cache.append(entry)
        self.push(f'Log:{config}', 'add', entry)

    def _flush(self):
        with self._pending_lock:
            batch, self._pending = self._pending, []
            self._flush_scheduled = False
        for topic, op, value in batch:
            self._broadcast(topic, op, value)

    def _broadcast(self, topic, op, value):
        msg = json.dumps({'t': topic, 'o': op, 'v': value}, ensure_ascii=False, default=str)
        for ws in list(self.topics.get(topic, ())):
            self._send(ws, msg)

    def _send(self, ws, text):
        async def _send():
            try:
                await ws.send_text(text)
            except Exception:
                self._drop(ws)

        asyncio.ensure_future(_send())

    def _drop(self, ws):
        for topic in self.subs.get(ws, ()):  # noqa
            targets = self.topics.get(topic)
            if targets:
                targets.discard(ws)

    # ---------- connection lifecycle (loop context) ----------

    def connect(self, ws):
        self.subs[ws] = set()

    def disconnect(self, ws):
        for topic in self.subs.pop(ws, ()):  # noqa
            targets = self.topics.get(topic)
            if targets:
                targets.discard(ws)

    async def subscribe(self, ws, topic):
        prefix, _, arg = topic.partition(':')
        if prefix == 'Log':
            full = list(self.log_cache.get(arg, ()))
        else:
            provider = self.providers.get(prefix)
            if provider is None:
                await ws.send_text(json.dumps({'t': topic, 'e': f'Unknown topic: {prefix}'}))
                return
            full = await asyncio.to_thread(provider, arg or None)
        self.subs.setdefault(ws, set()).add(topic)
        self.topics.setdefault(topic, set()).add(ws)
        await ws.send_text(json.dumps({'t': topic, 'o': 'full', 'v': full}, ensure_ascii=False, default=str))

    async def unsubscribe(self, ws, topic):
        self.subs.get(ws, set()).discard(topic)
        targets = self.topics.get(topic)
        if targets:
            targets.discard(ws)

    async def rpc(self, ws, topic, fn, params, rpc_id):
        prefix, _, arg = topic.partition(':')
        handler = self.rpc_handlers.get((prefix, fn))
        if handler is None:
            await ws.send_text(json.dumps({'t': topic, 'i': rpc_id, 'e': f'Unknown rpc: {prefix}.{fn}'}))
            return
        try:
            result = await asyncio.to_thread(handler, arg or None, params or {})
            error = None
        except Exception as e:
            result, error = None, str(e)
        await ws.send_text(
            json.dumps({'t': topic, 'i': rpc_id, 'e': error, 'r': result}, ensure_ascii=False, default=str))

    async def handle(self, ws, msg):
        topic = msg.get('t')
        op = msg.get('o', 'sub')
        if op == 'sub':
            await self.subscribe(ws, topic)
        elif op == 'unsub':
            await self.unsubscribe(ws, topic)
        elif op == 'rpc':
            await self.rpc(ws, topic, msg.get('f'), msg.get('v'), msg.get('i'))

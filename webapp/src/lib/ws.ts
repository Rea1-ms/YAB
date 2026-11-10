import type { ClientMsg, RpcReply, ServerData, ServerMsg } from './types';
import { tNow } from './i18n';

export type DataHandler = (msg: ServerData) => void;
export type ConnHandler = (up: boolean) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 15000;
const MAX_BACKOFF_MS = 10000;

function isRpcReply(msg: ServerMsg): msg is RpcReply {
  return typeof (msg as RpcReply).i === 'number';
}

function isServerData(msg: ServerMsg): msg is ServerData {
  const o = (msg as ServerData).o;
  return o === 'full' || o === 'add' || o === 'set';
}

/**
 * WebSocket 管理：topic 订阅（引用计数，归零自动 unsub）、
 * 断线指数退避重连（重连后重新订阅）、RPC Promise 封装。
 * 回执与推送到达顺序不固定，按 i / o 字段区分。
 */
class WebsocketManager {
  private ws: WebSocket | null = null;
  private topics = new Set<string>();
  private handlers = new Map<string, Set<DataHandler>>();
  private connHandlers = new Set<ConnHandler>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}/api/ws`);
    this.ws = socket;
    socket.onopen = () => {
      this.backoffMs = 1000;
      // 重连后重新订阅所有动态 topic；Meta/ConfigScan 由服务端在连接建立时自动订阅
      for (const topic of this.topics) this.rawSend({ t: topic, o: 'sub' });
      for (const h of [...this.connHandlers]) h(true);
    };
    socket.onmessage = (ev) => this.onMessage(String(ev.data));
    socket.onclose = () => this.onDown();
  }

  /** 订阅 topic，返回取消订阅函数（最后一个处理器移除时发送 unsub） */
  subscribe(topic: string, handler: DataHandler): () => void {
    let set = this.handlers.get(topic);
    const first = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    if (first) {
      this.topics.add(topic);
      this.rawSend({ t: topic, o: 'sub' });
    }
    return () => {
      const cur = this.handlers.get(topic);
      if (!cur || !cur.delete(handler)) return;
      if (cur.size === 0) {
        this.handlers.delete(topic);
        this.topics.delete(topic);
        this.rawSend({ t: topic, o: 'unsub' });
      }
    };
  }

  /** 注册全局自动订阅 topic（Meta/ConfigScan）的处理器，不发送 sub */
  bindPassive(topic: string, handler: DataHandler): void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
  }

  onConnection(handler: ConnHandler): () => void {
    this.connHandlers.add(handler);
    return () => this.connHandlers.delete(handler);
  }

  /** RPC 调用：e 非 null 时 reject，超时 15s */
  rpc<T = unknown>(topic: string, fn: string, args: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(tNow()('未连接到后端服务')));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(tNow()('RPC 超时：{0}').replace('{0}', () => `${topic}.${fn}`)));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.rawSend({ t: topic, o: 'rpc', f: fn, v: args, i: id });
    });
  }

  private rawSend(msg: ClientMsg): void {
    const socket = this.ws;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  private onMessage(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    if (isRpcReply(msg)) {
      const p = this.pending.get(msg.i);
      if (!p) return;
      this.pending.delete(msg.i);
      clearTimeout(p.timer);
      if (msg.e) p.reject(new Error(msg.e));
      else p.resolve(msg.r);
      return;
    }
    if (isServerData(msg)) {
      const set = this.handlers.get(msg.t);
      if (set) for (const h of [...set]) h(msg);
      return;
    }
    // 其余（{"t","e"} 未知 topic 错误）静默忽略
  }

  private onDown(): void {
    this.ws = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(tNow()('连接已断开')));
    }
    this.pending.clear();
    for (const h of [...this.connHandlers]) h(false);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export const ws = new WebsocketManager();

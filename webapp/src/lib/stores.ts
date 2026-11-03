import { get, writable, type Writable } from 'svelte/store';
import { ws } from './ws';
import { toast } from './toast';
import type {
  ConfigArgs,
  ConfigEntry,
  EventItem,
  LogEntry,
  Meta,
  RuntimeState,
  ServerData,
} from './types';

const LOG_MAX = 500;
const DIR_PREFIXES = ['Log', 'State', 'ConfigArg', 'EventConfig'] as const;

/** 全局 topic（服务端连接建立时自动订阅推送） */
export const meta = writable<Meta | null>(null);
export const configScan = writable<ConfigEntry[]>([]);
export const connected = writable(false);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 按合并数据：full 覆盖、add 追加（数组）、set 浅合并（对象） */
function applyData(prev: unknown, msg: ServerData): unknown {
  const v = msg.v;
  if (msg.o === 'full') return v;
  if (msg.o === 'add') {
    if (Array.isArray(prev)) return [...prev, ...(Array.isArray(v) ? v : [v])];
    return v;
  }
  if (isPlainObject(prev) && isPlainObject(v)) return { ...prev, ...v };
  return v;
}

ws.bindPassive('Meta', (msg) => meta.update((prev) => applyData(prev, msg) as Meta));
ws.bindPassive('ConfigScan', (msg) => configScan.update((prev) => applyData(prev, msg) as ConfigEntry[]));
ws.onConnection((up) => connected.set(up));

/** 每个配置目录的四个动态 topic store */
export interface DirStores {
  log: Writable<LogEntry[]>;
  state: Writable<RuntimeState | null>;
  args: Writable<ConfigArgs | null>;
  events: Writable<EventItem[] | null>;
}

const dirStores = new Map<string, DirStores>();
const trackedUnsubs = new Map<string, () => void>();
let activeDir: string | null = null;

function subDir(dir: string, s: DirStores): void {
  const logKey = `Log:${dir}`;
  if (!trackedUnsubs.has(logKey)) {
    trackedUnsubs.set(
      logKey,
      ws.subscribe(logKey, (msg) => {
        if (msg.o === 'full') {
          s.log.set(Array.isArray(msg.v) ? (msg.v as LogEntry[]).slice(-LOG_MAX) : []);
        } else if (msg.o === 'add') {
          s.log.update((cur) => {
            const add = Array.isArray(msg.v) ? (msg.v as LogEntry[]) : [msg.v as LogEntry];
            return [...cur, ...add].slice(-LOG_MAX);
          });
        }
      }),
    );
  }
  const bind = <T>(prefix: string, store: Writable<T>): void => {
    const key = `${prefix}:${dir}`;
    if (!trackedUnsubs.has(key)) {
      trackedUnsubs.set(
        key,
        ws.subscribe(key, (msg) => store.update((p) => applyData(p, msg) as T)),
      );
    }
  };
  bind('State', s.state);
  bind('ConfigArg', s.args);
  bind('EventConfig', s.events);
}

/** 获取某配置的四个 topic store（首次调用时向服务端订阅） */
export function getDirStores(dir: string): DirStores {
  let s = dirStores.get(dir);
  if (!s) {
    s = {
      log: writable<LogEntry[]>([]),
      state: writable<RuntimeState | null>(null),
      args: writable<ConfigArgs | null>(null),
      events: writable<EventItem[] | null>(null),
    };
    dirStores.set(dir, s);
  }
  subDir(dir, s);
  return s;
}

/** 切换激活配置：退订上一个配置的动态 topic，避免无关推送 */
export function setActiveDir(dir: string | null): void {
  if (activeDir === dir) return;
  const old = activeDir;
  activeDir = dir;
  if (old) {
    for (const p of DIR_PREFIXES) {
      const key = `${p}:${old}`;
      const u = trackedUnsubs.get(key);
      if (u) {
        trackedUnsubs.delete(key);
        u();
      }
    }
  }
}

/** RPC 封装：失败弹 toast 并返回 undefined */
export async function callRpc<T = unknown>(
  topic: string,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T | undefined> {
  try {
    return await ws.rpc<T>(topic, fn, args);
  } catch (err) {
    toast('error', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/** 写入单个配置项：本地乐观更新 + set RPC（失败回滚，服务端随后推送 full） */
export async function setConfigValue(dir: string, key: string, value: unknown): Promise<boolean> {
  const s = getDirStores(dir);
  const prev = get(s.args);
  s.args.set({ ...(prev ?? {}), [key]: value });
  const r = await callRpc(`ConfigArg:${dir}`, 'set', { key, value });
  if (r === undefined) {
    s.args.set(prev ?? {});
    return false;
  }
  return true;
}

/** 切换单个事件启用状态：乐观更新 + set_event RPC（失败回滚） */
export async function setEventEnabled(dir: string, funcName: string, enabled: boolean): Promise<void> {
  const s = getDirStores(dir);
  const prev = get(s.events);
  if (prev) s.events.set(prev.map((e) => (e.func_name === funcName ? { ...e, enabled } : e)));
  const r = await callRpc(`EventConfig:${dir}`, 'set_event', {
    func_name: funcName,
    patch: { enabled },
  });
  if (r === undefined && prev) s.events.set(prev);
}

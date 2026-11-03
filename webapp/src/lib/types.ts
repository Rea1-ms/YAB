/** WS 协议消息与页面数据模型 */

/** Meta topic：全局元信息 */
export interface Meta {
  version: string;
  ocr_ready: boolean;
  ocr_error: string | null;
  screenshot_methods: string[];
  control_methods: string[];
  then_options: string[];
  servers: string[];
  multi_emulator_names: Record<string, string>;
  event_names: Record<string, string>;
}

/** ConfigScan topic 条目 */
export interface ConfigEntry {
  dir: string;
  name: string;
}

/** 日志级别：1 信息 2 警告 3 错误 4 严重 */
export type LogLevel = 1 | 2 | 3 | 4;

export interface LogEntry {
  l: LogLevel;
  m: string;
  t: number; // epoch 秒
}

/** State topic：运行状态 */
export interface RuntimeState {
  running: boolean;
  button: string;
  current: string;
  waiting: string[];
}

export type Hms = [number, number, number];
export type DisabledRange = [Hms, Hms];

/** EventConfig topic 条目 */
export interface EventItem {
  func_name: string;
  event_name: string;
  enabled: boolean;
  next_tick: number; // epoch 秒
  priority: number;
  interval: number; // 秒
  daily_reset: Hms[];
  disabled_time_range: DisabledRange[];
  pre_task: string[];
  post_task: string[];
}

/** ConfigArg topic：配置全部键值 */
export type ConfigArgs = Record<string, unknown>;

/** 服务端数据推送（full 覆盖 / add 追加 / set 局部合并） */
export interface ServerData {
  t: string;
  o: 'full' | 'add' | 'set';
  v: unknown;
}

/** RPC 回执（按 i 字段与数据推送区分） */
export interface RpcReply {
  t: string;
  i: number;
  e: string | null;
  r?: unknown;
}

/** 未知 topic 等错误提示（无 o/i 字段） */
export interface ServerError {
  t: string;
  e: string;
}

export type ServerMsg = ServerData | RpcReply | ServerError;

export interface SubMsg {
  t: string;
  o: 'sub';
}
export interface UnsubMsg {
  t: string;
  o: 'unsub';
}
export interface RpcMsg {
  t: string;
  o: 'rpc';
  f: string;
  v?: Record<string, unknown>;
  i: number;
}
export type ClientMsg = SubMsg | UnsubMsg | RpcMsg;

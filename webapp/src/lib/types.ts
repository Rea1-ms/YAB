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

/** ---------- Panels topic：结构化面板 schema ---------- */

export type PanelFieldType =
  | 'switch'
  | 'text'
  | 'number'
  | 'select'
  | 'checklist'
  | 'shop_checklist'
  | 'ordered_checklist'
  | 'student_text'
  | 'slots_select'
  | 'tag_list'
  | 'lesson_editor'
  | 'sweep_editor'
  | 'actions';

/** select / checklist 选项：字符串或 {value,label}（由后端解析后下发） */
export type OptionItem = string | { value: string; label: string };

/** 商品行（shop_checklist options；tactical 行无 currency） */
export interface ShopRow {
  name: string;
  price: number;
  currency?: string;
}

/** actions 字段的动作按钮 */
export interface ActionItem {
  label: string;
  task: string;
}

/** sweep_editor 的按学生添加项（stages 为完整 "区-关-次数" 串） */
export interface StudentStages {
  student: string;
  stages: string[];
}

/** 面板字段定义（key 以 __ 开头表示无配置键的动作字段） */
export interface PanelField {
  key?: string;
  type: PanelFieldType;
  label: string;
  help?: string;
  max?: number;
  coerce?: 'int' | 'int[]';
  options?: OptionItem[] | ShopRow[];
  actions?: ActionItem[];
  sweep_key?: string;
  normal?: boolean;
  student_stages?: StudentStages[];
  levels?: string[];
  level_labels?: string[];
}

export interface PanelGroup {
  title: string;
  fields: PanelField[];
}

export interface Panel {
  id: string;
  name: string;
  page: 'config' | 'settings';
  tip?: string;
  groups: PanelGroup[];
}

/** Panels:<dir> topic full 数据（cards 为旧 switch.json 元数据，暂不渲染） */
export interface PanelsData {
  panels: Panel[];
  cards: unknown[];
}

/** ---------- Assets RPC ---------- */

/** 资产计数：-1/0 表示尚未识别 */
export interface AssetCount {
  count: number;
  max?: number;
  time?: number; // epoch 秒
}

export interface AssetPass {
  level?: number;
  [key: string]: unknown;
}

/** Assets:<dir>.get 返回 */
export interface AssetsData {
  ap?: AssetCount | null;
  creditpoints?: AssetCount | null;
  pyroxene?: AssetCount | null;
  tactical_challenge_coin?: AssetCount | null;
  bounty_coin?: AssetCount | null;
  _pass?: AssetPass | null;
  'Keystone-Piece'?: number | null;
  Keystone?: number | null;
}

/** ---------- Meta 更新设置 / 帮助文档 ---------- */

export interface UpdateInfo {
  has_setup_toml: boolean;
  current_version: string;
  mirrorc_cdk?: string;
  repo_url_http?: string;
  get_remote_sha_method?: string;
}

export interface CdkTestResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ShaTestResult {
  ok: boolean;
  sha?: string | null;
  elapsed?: number;
  error?: string;
}

export interface HelpLangEntry {
  lang: string;
  files: string[];
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

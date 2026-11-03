/** 字段渲染组件的公共工具：选项规范化、值规范化与保存封装 */
import { setConfigValue } from '../../stores';
import { toast } from '../../toast';
import type { OptionItem, PanelField, ShopRow } from '../../types';

/** select 选项统一为 [value,label] 对 */
export function toOptionPairs(options: OptionItem[] | undefined): [string, string][] {
  if (!options) return [];
  return options.map((o) => {
    if (typeof o === 'string') return [o, o] as [string, string];
    const v = o.value == null ? '' : String(o.value);
    return [v, o.label == null ? v : String(o.label)] as [string, string];
  });
}

/** 纯字符串选项（checklist / student_text / slots_select / lesson 区域等） */
export function toPlainStrings(options: unknown[] | undefined): string[] {
  return (options ?? []).map((o) => {
    if (typeof o === 'string') return o;
    if (typeof o === 'object' && o !== null && 'value' in o) {
      return String((o as { value?: unknown }).value ?? '');
    }
    return String(o);
  });
}

/** checklist / ordered_checklist / tag_list / student_text 的字符串数组视图 */
export function toStringArray(v: unknown): string[] {
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [];
}

/** shop_checklist：与 options 下标对齐的 0/1 标志数组（短补 0，长截断） */
export function toFlagArray(v: unknown, len: number): number[] {
  const src = Array.isArray(v) ? v : [];
  const flags: number[] = [];
  for (let i = 0; i < len; i++) {
    const x = src[i];
    flags.push(x === 1 || x === '1' ? 1 : 0);
  }
  return flags;
}

/** 商品行判断 */
export function isShopRow(o: unknown): o is ShopRow {
  return typeof o === 'object' && o !== null && !Array.isArray(o) && 'name' in o;
}

/** 商品货币单位显示：creditpoints → 信用点，其余（含 tactical 无 currency）→ 竞技币 */
export function currencyLabel(currency: string | undefined): string {
  return currency === 'creditpoints' ? '信用点' : '竞技币';
}

function fieldKey(field: PanelField): string {
  if (!field.key) throw new Error(`字段 ${field.label} 缺少配置键`);
  return field.key;
}

/** switch / 数组类字段的直接保存 */
export async function saveFieldValue(dir: string, field: PanelField, value: unknown): Promise<boolean> {
  return setConfigValue(dir, fieldKey(field), value);
}

/**
 * number 字段保存：coerce='int' 时存 int；
 * 否则保持与现值相同类型（现值是字符串就存字符串）。
 * raw 非法或超过 max 时提示/截断。
 */
export async function saveNumberValue(dir: string, field: PanelField, raw: string, current: unknown): Promise<boolean> {
  const text = raw.trim();
  const n = Number(text);
  if (text === '' || Number.isNaN(n)) {
    toast('error', `${field.label}：请输入有效数字`);
    return false;
  }
  let v = n;
  if (field.max !== undefined && v > field.max) v = field.max;
  if (field.coerce === 'int') return setConfigValue(dir, fieldKey(field), Math.trunc(v));
  // 现值是字符串则保持字符串
  return setConfigValue(dir, fieldKey(field), typeof current === 'string' ? String(v) : v);
}

/** select 字段保存：coerce='int' 时转 int，否则 value 原样保存 */
export async function saveSelectValue(dir: string, field: PanelField, raw: string): Promise<boolean> {
  const v = field.coerce === 'int' ? Math.trunc(Number(raw)) : raw;
  return setConfigValue(dir, fieldKey(field), v);
}

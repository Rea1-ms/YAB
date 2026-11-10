import { derived, writable } from 'svelte/store';
import en from './locales/en_US';
import ja from './locales/ja_JP';
import ko from './locales/ko_KR';
import overrides from './overrides';

export type LocaleCode = 'zh_CN' | 'en_US' | 'ja_JP' | 'ko_KR';

export const LOCALES: { code: LocaleCode; label: string }[] = [
  { code: 'zh_CN', label: '简体中文' },
  { code: 'en_US', label: 'English' },
  { code: 'ja_JP', label: '日本語' },
  { code: 'ko_KR', label: '한국어' },
];

const DICTS: Partial<Record<LocaleCode, Record<string, string>>> = {
  en_US: { ...en, ...(overrides.en_US ?? {}) },
  ja_JP: { ...ja, ...(overrides.ja_JP ?? {}) },
  ko_KR: { ...ko, ...(overrides.ko_KR ?? {}) },
};

const STORAGE_KEY = 'baas.lang';

function initialLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh_CN' || saved === 'en_US' || saved === 'ja_JP' || saved === 'ko_KR') return saved;
    const nav = navigator.language.replace('-', '_');
    if (nav.startsWith('zh')) return 'zh_CN';
    if (nav.startsWith('ja')) return 'ja_JP';
    if (nav.startsWith('ko')) return 'ko_KR';
    if (nav.startsWith('en')) return 'en_US';
  } catch {
    /* localStorage 不可用时回退默认 */
  }
  return 'zh_CN';
}

/** 当前语言（localStorage 持久化，简体中文为源语言无需词典） */
export const locale = writable<LocaleCode>(initialLocale());

locale.subscribe((v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore */
  }
});

/** 翻译函数：以中文原文为 key，缺失时回退原文。模板中用 {$t('中文')} */
export const t = derived(locale, (l) => (src: string): string => {
  // Keep stored option values and generated translation keys compatible with old configs.
  const label = l === 'zh_CN' ? src : (DICTS[l]?.[src] ?? src);
  return label.replace(/\bBAAS\b/gi, 'YAB').replace(/Blue Archive Auto Script/g, 'YAB');
});

/** 在脚本代码中取当前翻译函数 */
export function tNow(): (src: string) => string {
  let fn: (src: string) => string = (s) => s;
  t.subscribe((f) => (fn = f))();
  return fn;
}

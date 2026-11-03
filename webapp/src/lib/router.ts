import { writable } from 'svelte/store';

/** 导航页定义 */
export const PAGES = [
  { id: 'home', label: '主页' },
  { id: 'schedule', label: '调度' },
  { id: 'settings', label: '设置' },
  { id: 'advanced', label: '高级' },
] as const;

export type PageId = (typeof PAGES)[number]['id'];

export interface Route {
  dir: string;
  page: PageId;
}

function parse(): Route | null {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return null;
  const [d = '', p = ''] = raw.split('/');
  let dir = d;
  try {
    dir = decodeURIComponent(d);
  } catch {
    // 保持原样
  }
  if (!dir) return null;
  const page: PageId = PAGES.some((x) => x.id === p) ? (p as PageId) : 'home';
  return { dir, page };
}

export const route = writable<Route | null>(parse());

window.addEventListener('hashchange', () => route.set(parse()));

export function navigate(dir: string, page: PageId): void {
  const target = `#/${encodeURIComponent(dir)}/${page}`;
  if (location.hash === target) return;
  location.hash = target;
}

/** 新建配置后等待其出现在 ConfigScan 再跳转的目录名 */
export const pendingNavDir = writable<string | null>(null);

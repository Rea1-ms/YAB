import { writable } from 'svelte/store';

/** 导航页定义 */
export const PAGES = [
  { id: 'home', label: '主页' },
  { id: 'schedule', label: '调度' },
  { id: 'config', label: '配置' },
  { id: 'settings', label: '设置' },
  { id: 'advanced', label: '高级' },
] as const;

/** 全局页定义（不属于某个配置目录，路由形如 #/update） */
export const GLOBAL_PAGES = [{ id: 'update', label: '更新与帮助' }] as const;

export type PageId = (typeof PAGES)[number]['id'];
export type GlobalPageId = (typeof GLOBAL_PAGES)[number]['id'];

export interface DirRoute {
  dir: string;
  page: PageId;
  global?: undefined;
}

export interface GlobalRoute {
  global: GlobalPageId;
  dir?: undefined;
  page?: undefined;
}

export type Route = DirRoute | GlobalRoute;

function parse(): Route | null {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return null;
  const [d = '', p = ''] = raw.split('/');
  // 仅无第二段时视为全局页，避免与同名配置目录冲突
  if (!p && GLOBAL_PAGES.some((x) => x.id === d)) return { global: d as GlobalPageId };
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

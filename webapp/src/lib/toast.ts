import { writable } from 'svelte/store';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export const toasts = writable<Toast[]>([]);
let nextId = 1;

export function toast(kind: Toast['kind'], text: string): void {
  const id = nextId++;
  toasts.update((list) => [...list, { id, kind, text }]);
  setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 3500);
}

export function dismissToast(id: number): void {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

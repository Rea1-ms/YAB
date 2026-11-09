import { writable } from 'svelte/store';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  duration: number;
}

export const toasts = writable<Toast[]>([]);
let nextId = 1;

export function toast(kind: Toast['kind'], text: string): void {
  const id = nextId++;
  const duration = kind === 'error' ? 8000 : 3500;
  toasts.update((list) => [...list, { id, kind, text, duration }]);
}

export function dismissToast(id: number): void {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

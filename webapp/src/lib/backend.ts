import { writable } from 'svelte/store';
import type { BackendState } from './desktop';

export const desktopBackend = writable<BackendState>({
  revision: 0, generation: 0, recovering: false, logs: [],
});

let revision = -1;
function update(state: BackendState): void {
  if (state.revision < revision) return;
  revision = state.revision;
  desktopBackend.set(state);
}

const bridge = window.yabDesktop;
bridge?.onBackendState?.(update);
void bridge?.getBackendState?.().then(update).catch(() => {});

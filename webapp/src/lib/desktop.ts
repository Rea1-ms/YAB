export const closeActions = ['仅关闭窗口', '开启轻量模式', '询问'] as const;
export type CloseAction = typeof closeActions[number];

export interface BackendState {
  revision: number;
  generation: number;
  recovering: boolean;
  logs: import('./types').LogEntry[];
}

export interface DesktopBridge {
  isDesktop: boolean;
  getCloseAction?: () => Promise<CloseAction>;
  setCloseAction?: (action: CloseAction) => Promise<CloseAction>;
  getBackendState?: () => Promise<BackendState>;
  onBackendState?: (callback: (state: BackendState) => void) => () => void;
  getUpdateState?: () => Promise<DesktopUpdateState>;
  checkUpdate?: (options?: { automatic?: boolean }) => Promise<DesktopUpdateState>;
  setUpdateSchedule?: (schedule: { enabled: boolean; time: string }) => Promise<DesktopUpdateState>;
  downloadUpdate?: () => Promise<DesktopUpdateState>;
  installUpdate?: () => Promise<DesktopUpdateState>;
  onUpdateState?: (callback: (state: DesktopUpdateState) => void) => () => void;
}

export interface DesktopUpdateState {
  revision: number;
  enabled: boolean;
  reason: string;
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'preparing' | 'installing' | 'error';
  currentVersion: string;
  latestVersion: string;
  variant: 'offline' | 'lite' | 'lite-system';
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  notes: string;
  error: string;
  lastResult: string;
  schedule: { enabled: boolean; time: string };
}

declare global {
  interface Window { yabDesktop?: DesktopBridge; }
}

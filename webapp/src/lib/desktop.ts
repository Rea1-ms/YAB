export const closeActions = ['仅关闭窗口', '开启轻量模式', '询问'] as const;
export type CloseAction = typeof closeActions[number];

export interface DesktopBridge {
  isDesktop: boolean;
  getCloseAction?: () => Promise<CloseAction>;
  setCloseAction?: (action: CloseAction) => Promise<CloseAction>;
}

declare global {
  interface Window { yabDesktop?: DesktopBridge; }
}

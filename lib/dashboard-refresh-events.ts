export const DASHBOARD_REFRESH_EVENT = 'wechat-dashboard:data-updated';

export type DashboardRefreshReason =
  | 'content-sync-completed'
  | 'semantic-analysis-imported';

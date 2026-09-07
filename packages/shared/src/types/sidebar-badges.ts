export interface SidebarBadges {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  /** 1 when the company's open weekly check-up still has suggestions waiting on the board, else 0. */
  checkups: number;
}

export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardPulseApproval {
  approvalId: string;
  /** `payload.kind` for a `request_board_approval` (e.g. "deploy", "merge_pr"), else the approval's own `type`. */
  type: string;
  title: string | null;
  requestedByAgentName: string | null;
  createdAt: string;
}

export interface DashboardPulseExecution {
  issueId: string;
  issueIdentifier: string | null;
  title: string;
  agentId: string | null;
  agentName: string | null;
  startedAt: string | null;
}

export interface DashboardPulseCompletion {
  issueId: string;
  issueIdentifier: string | null;
  title: string;
  agentId: string | null;
  agentName: string | null;
  completedAt: string;
}

export interface DashboardPulseDeploy {
  approvalId: string;
  title: string | null;
  status: string;
  commit: string | null;
  committedAt: string;
  /** Null until the deploy runner's status log reports a health-checked success for this approval. */
  deployedAt: string | null;
}

export interface DashboardPulseBudget {
  spentTodayCents: number;
  dailyLimitCents: number | null;
  percentage: number | null;
  status: "ok" | "warning" | "critical";
}

export interface DashboardPulse {
  companyId: string;
  needsYouCount: number;
  needsYouByType: Record<string, number>;
  needsYou: DashboardPulseApproval[];
  activeExecutions: DashboardPulseExecution[];
  recentCompletions: DashboardPulseCompletion[];
  budget: DashboardPulseBudget;
  deploys: DashboardPulseDeploy[];
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}

export type IssueSizeLabel = "S" | "M" | "L";

export const ISSUE_SIZE_LABELS: readonly IssueSizeLabel[] = ["S", "M", "L"];

const SIZE_WEIGHTS: Record<IssueSizeLabel, number> = { S: 1, M: 2, L: 3 };
const DEFAULT_WEIGHT = 1;
const MIN_DONE_FOR_ETA = 2;

export interface IssueProgressChild {
  status: string;
  sizeLabel?: IssueSizeLabel | null;
}

export interface IssueProgressSnapshot {
  totalCount: number;
  totalWeight: number;
}

export interface IssueProgress {
  completedCount: number;
  totalCount: number;
  completedWeight: number;
  totalWeight: number;
  /** 0-100, rounded */
  percent: number;
  etaAt: Date | null;
  etaLabel: string | null;
  planGrew: boolean;
  /** e.g. "plan grew 7 → 8"; null when the plan did not grow */
  planGrewLabel: string | null;
  /** Persist and pass back as `previous` on the next computation. */
  snapshot: IssueProgressSnapshot;
}

export function issueSizeWeight(label: IssueSizeLabel | null | undefined): number {
  return label ? (SIZE_WEIGHTS[label] ?? DEFAULT_WEIGHT) : DEFAULT_WEIGHT;
}

function formatClock(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatEtaLabel(remainingMs: number, etaAt: Date): string {
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  let left: string;
  if (minutes < 60) {
    left = `${minutes} min`;
  } else if (minutes < 60 * 24) {
    const hours = Math.round(minutes / 6) / 10; // 1 decimal
    left = `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  } else {
    const days = Math.round(minutes / 144) / 10;
    left = `${Number.isInteger(days) ? days : days.toFixed(1)} d`;
  }
  return `about ${left} left (≈ ${formatClock(etaAt)})`;
}

export function computeIssueProgress(input: {
  children: IssueProgressChild[];
  startedAt: Date | string | null | undefined;
  now?: Date;
  previous?: IssueProgressSnapshot | null;
}): IssueProgress {
  const now = input.now ?? new Date();
  // Cancelled sub-tasks are not part of the plan.
  const counted = input.children.filter((c) => c.status !== "cancelled");
  let completedWeight = 0;
  let totalWeight = 0;
  let completedCount = 0;
  for (const child of counted) {
    const weight = issueSizeWeight(child.sizeLabel);
    totalWeight += weight;
    if (child.status === "done") {
      completedWeight += weight;
      completedCount += 1;
    }
  }
  const totalCount = counted.length;
  const percent = totalWeight > 0 ? Math.round((completedWeight / totalWeight) * 100) : 0;

  let etaAt: Date | null = null;
  let etaLabel: string | null = null;
  const startedMs = input.startedAt ? new Date(input.startedAt).getTime() : NaN;
  const elapsedMs = now.getTime() - startedMs;
  if (
    completedCount >= MIN_DONE_FOR_ETA &&
    completedWeight > 0 &&
    completedWeight < totalWeight &&
    Number.isFinite(elapsedMs) &&
    elapsedMs > 0
  ) {
    const remainingMs = ((totalWeight - completedWeight) * elapsedMs) / completedWeight;
    etaAt = new Date(now.getTime() + remainingMs);
    etaLabel = formatEtaLabel(remainingMs, etaAt);
  }

  const prev = input.previous ?? null;
  const planGrew = !!prev && (totalCount > prev.totalCount || totalWeight > prev.totalWeight);
  const planGrewLabel = planGrew && prev
    ? totalCount > prev.totalCount
      ? `plan grew ${prev.totalCount} → ${totalCount}`
      : `plan grew ${prev.totalWeight} → ${totalWeight} (weight)`
    : null;

  return {
    completedCount,
    totalCount,
    completedWeight,
    totalWeight,
    percent,
    etaAt,
    etaLabel,
    planGrew,
    planGrewLabel,
    snapshot: { totalCount, totalWeight },
  };
}

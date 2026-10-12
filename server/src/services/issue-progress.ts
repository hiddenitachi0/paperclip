import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { issues } from "@paperclipai/db";
import {
  computeIssueProgress,
  type IssueProgress,
  type IssueSizeLabel,
} from "@paperclipai/shared";

const CHUNK = 500;

/**
 * Read-only derived progress/ETA for parent issues, from their direct
 * children. One batched query per company/chunk (no N+1). Parents with no
 * (non-cancelled) children are absent from the result.
 */
export async function progressMapForParents(
  dbOrTx: any,
  parents: Array<{ id: string; companyId: string; startedAt: Date | string | null }>,
  now: Date = new Date(),
): Promise<Map<string, IssueProgress>> {
  const map = new Map<string, IssueProgress>();
  if (parents.length === 0) return map;
  const byCompany = new Map<string, typeof parents>();
  for (const p of parents) {
    const list = byCompany.get(p.companyId) ?? [];
    list.push(p);
    byCompany.set(p.companyId, list);
  }
  for (const [companyId, list] of byCompany) {
    const childrenByParent = new Map<string, Array<{ status: string; sizeLabel: IssueSizeLabel | null }>>();
    for (let i = 0; i < list.length; i += CHUNK) {
      const ids = list.slice(i, i + CHUNK).map((p) => p.id);
      const rows = await dbOrTx
        .select({ parentId: issues.parentId, status: issues.status, sizeLabel: issues.sizeLabel })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), isNotNull(issues.parentId), inArray(issues.parentId, ids)));
      for (const row of rows) {
        const arr = childrenByParent.get(row.parentId) ?? [];
        arr.push({ status: row.status, sizeLabel: (row.sizeLabel as IssueSizeLabel | null) ?? null });
        childrenByParent.set(row.parentId, arr);
      }
    }
    for (const p of list) {
      const children = childrenByParent.get(p.id);
      if (!children || children.every((c) => c.status === "cancelled")) continue;
      map.set(p.id, computeIssueProgress({ children, startedAt: p.startedAt, now }));
    }
  }
  return map;
}

/** "DUR-4378 is 60% done, about 1.5 d left". Null unless an ETA exists (needs >=2 done sub-tasks). */
export function formatProgressReportLine(identifier: string, progress: IssueProgress): string | null {
  if (!progress.etaLabel) return null;
  const left = progress.etaLabel.replace(/\s*\(≈[^)]*\)\s*$/, "");
  return `${identifier} is ${progress.percent}% done, ${left}`;
}

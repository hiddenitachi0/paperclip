import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { modelDirectoryConverters, modelDirectoryEntries, modelSetupReviews } from "@paperclipai/db";
import {
  modelConverterOpsIssue,
  parseModelConverterOps,
  type ModelConverterOp,
  type ModelHostCapabilities,
  type ModelProbeSetResult,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { createModelSetupProbes, type ProbeEntry } from "./model-setup-probes.js";
import {
  decideChange,
  findProblems,
  mergeOps,
  proposeChanges,
  scoreProbes,
  summarize,
  type CapabilityScores,
  type ReviewedSettings,
  type ReviewFinding,
  type ReviewProposal,
} from "./model-setup-reviewer-logic.js";

/**
 * DUR-4558: the model setup reviewer. For one directory entry it reads the
 * host's capabilities, runs the fixed probe set, proposes allow-listed
 * changes (settings + converter ops), reruns the probes with each change in
 * place, and applies it only when nothing got worse and no capability is
 * dropped; otherwise it leaves it as a proposal for the owner.
 *
 * Writes are confined to: the three reviewed settings on the entry, that
 * entry's converter row, and the review history row. No key, address, host
 * restriction or cost limit is read into a report or changed. Company-scoped
 * on every query. Probes cost nothing (local models only) -- see
 * model-setup-probes.ts.
 */

type FetchLike = typeof fetch;
type ReviewRow = typeof modelSetupReviews.$inferSelect;

export type ReviewChangeStatus = "applied" | "proposed" | "declined" | "undone";
interface StateSnapshot {
  settings: ReviewedSettings;
  ops: ModelConverterOp[];
}
export interface ReviewChange {
  id: string;
  code: ReviewProposal["code"];
  title: string;
  why: string;
  status: ReviewChangeStatus;
  dropsCapability: boolean;
  before: StateSnapshot;
  after: StateSnapshot;
  probesAfter: ModelProbeSetResult | null;
  decidedAt: string | null;
}
export interface ModelSetupReview {
  id: string;
  entryId: string;
  trigger: string;
  createdAt: string;
  report: { summary: string; scores: CapabilityScores; findings: ReviewFinding[]; probes: ModelProbeSetResult };
  changes: ReviewChange[];
}

function toReview(row: ReviewRow): ModelSetupReview {
  return {
    id: row.id,
    entryId: row.entryId,
    trigger: row.trigger,
    createdAt: row.createdAt.toISOString(),
    report: row.report as unknown as ModelSetupReview["report"],
    changes: row.changes as unknown as ReviewChange[],
  };
}

// jsonb does not keep key order, so compare through the validated (schema-ordered) form.
const normalized = (s: StateSnapshot) => JSON.stringify({ settings: s.settings, ops: parseModelConverterOps(s.ops) });
const sameState = (a: StateSnapshot, b: StateSnapshot) => normalized(a) === normalized(b);

export function modelSetupReviewerService(db: Db, deps: { fetchImpl?: FetchLike; randomId?: () => string } = {}) {
  const probes = createModelSetupProbes(deps.fetchImpl ?? fetch);
  const newId = deps.randomId ?? (() => crypto.randomUUID());

  async function getEntry(companyId: string, entryId: string) {
    const [row] = await db
      .select()
      .from(modelDirectoryEntries)
      .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, entryId)));
    if (!row) throw notFound("Model setup not found");
    return row;
  }

  async function currentOps(companyId: string, entryId: string): Promise<ModelConverterOp[]> {
    const [row] = await db
      .select()
      .from(modelDirectoryConverters)
      .where(and(eq(modelDirectoryConverters.companyId, companyId), eq(modelDirectoryConverters.entryId, entryId)));
    // A stored list that no longer validates is treated as empty, never applied as-is.
    return row && modelConverterOpsIssue(row.ops) === null ? parseModelConverterOps(row.ops) : [];
  }

  const settingsOf = (e: { defaultThinking: string | null; defaultTemperature: number | null; defaultMaxOutputTokens: number | null }): ReviewedSettings => ({
    defaultThinking: e.defaultThinking === "on" || e.defaultThinking === "off" ? e.defaultThinking : null,
    defaultTemperature: e.defaultTemperature,
    defaultMaxOutputTokens: e.defaultMaxOutputTokens,
  });

  const probeEntryOf = (e: typeof modelDirectoryEntries.$inferSelect, settings: ReviewedSettings): ProbeEntry => ({
    id: e.id,
    provider: e.provider,
    model: e.model,
    baseUrl: e.baseUrl,
    providerRouting: e.providerRouting,
    ...settings,
  });

  /** The only writer of entry state: the three reviewed settings + the converter row. */
  async function writeState(companyId: string, entryId: string, state: StateSnapshot, userId: string | null) {
    const ops = parseModelConverterOps(state.ops);
    await db
      .update(modelDirectoryEntries)
      .set({
        defaultThinking: state.settings.defaultThinking,
        defaultTemperature: state.settings.defaultTemperature,
        defaultMaxOutputTokens: state.settings.defaultMaxOutputTokens,
        updatedByUserId: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, entryId)));
    await db
      .insert(modelDirectoryConverters)
      .values({ companyId, entryId, ops: ops as unknown as Record<string, unknown>[], createdByUserId: userId, updatedByUserId: userId })
      .onConflictDoUpdate({
        target: modelDirectoryConverters.entryId,
        set: { ops: ops as unknown as Record<string, unknown>[], updatedByUserId: userId, updatedAt: new Date() },
      });
  }

  async function stateOf(companyId: string, entryId: string): Promise<StateSnapshot> {
    const entry = await getEntry(companyId, entryId);
    return { settings: settingsOf(entry), ops: await currentOps(companyId, entryId) };
  }

  async function saveReview(row: ReviewRow, changes: ReviewChange[]) {
    const [updated] = await db
      .update(modelSetupReviews)
      .set({ changes: changes as unknown as Record<string, unknown>[] })
      .where(and(eq(modelSetupReviews.companyId, row.companyId), eq(modelSetupReviews.id, row.id)))
      .returning();
    return toReview(updated!);
  }

  async function getReviewRow(companyId: string, reviewId: string) {
    const [row] = await db
      .select()
      .from(modelSetupReviews)
      .where(and(eq(modelSetupReviews.companyId, companyId), eq(modelSetupReviews.id, reviewId)));
    if (!row) throw notFound("Review not found");
    return row;
  }

  async function review(companyId: string, entryId: string, opts: { trigger?: string; userId: string | null }): Promise<ModelSetupReview> {
    const entry = await getEntry(companyId, entryId);
    const startOps = await currentOps(companyId, entryId);
    const startSettings = settingsOf(entry);
    const caps: ModelHostCapabilities = await probes.fetchHostCapabilities(probeEntryOf(entry, startSettings));
    const before = await probes.runProbeSet(probeEntryOf(entry, startSettings), startOps);
    const problems = findProblems(before, caps);
    const proposals = proposeChanges({ ...startSettings, id: entry.id, provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl }, caps, before, startOps);
    const scores = scoreProbes(before);

    const changes: ReviewChange[] = [];
    let state: StateSnapshot = { settings: startSettings, ops: startOps };
    for (const p of proposals) {
      const next: StateSnapshot = { settings: { ...state.settings, ...p.settingsPatch }, ops: mergeOps(state.ops, p.addOps) };
      const after = p.evidence === "probes" && !p.dropsCapability ? await probes.runProbeSet(probeEntryOf(entry, next.settings), next.ops, p.settingsPatch.defaultThinking === "off" ? { onlyThinking: "off" } : {}) : null;
      const decision = decideChange(p, before, after);
      const change: ReviewChange = {
        id: newId(),
        code: p.code,
        title: p.title,
        why: p.why,
        status: decision === "apply" ? "applied" : "proposed",
        dropsCapability: p.dropsCapability,
        before: state,
        after: next,
        probesAfter: after,
        decidedAt: decision === "apply" ? new Date().toISOString() : null,
      };
      if (decision === "apply") {
        await writeState(companyId, entryId, next, opts.userId);
        state = next;
      }
      changes.push(change);
    }

    const [row] = await db
      .insert(modelSetupReviews)
      .values({
        companyId,
        entryId,
        trigger: opts.trigger ?? "manual",
        createdByUserId: opts.userId,
        report: { summary: summarize(scores, problems, proposals), scores, findings: problems, probes: before } as unknown as Record<string, unknown>,
        changes: changes as unknown as Record<string, unknown>[],
      })
      .returning();
    return toReview(row!);
  }

  return {
    review,

    async list(companyId: string, entryId: string): Promise<ModelSetupReview[]> {
      await getEntry(companyId, entryId);
      const rows = await db
        .select()
        .from(modelSetupReviews)
        .where(and(eq(modelSetupReviews.companyId, companyId), eq(modelSetupReviews.entryId, entryId)))
        .orderBy(desc(modelSetupReviews.createdAt))
        .limit(20);
      return rows.map(toReview);
    },

    /** The owner accepts a proposed change (the "card"). Refused unless the entry is still in the state the proposal was made against. */
    async applyProposed(companyId: string, reviewId: string, changeId: string, userId: string | null): Promise<ModelSetupReview> {
      const row = await getReviewRow(companyId, reviewId);
      const changes = row.changes as unknown as ReviewChange[];
      const change = changes.find((c) => c.id === changeId);
      if (!change) throw notFound("Change not found");
      if (change.status !== "proposed") throw conflict(`This change is already ${change.status}.`);
      if (!sameState(await stateOf(companyId, row.entryId), change.before)) {
        throw conflict("This setup changed after the review. Run the review again.");
      }
      const issue = modelConverterOpsIssue(change.after.ops);
      if (issue) throw unprocessable(issue);
      await writeState(companyId, row.entryId, change.after, userId);
      change.status = "applied";
      change.decidedAt = new Date().toISOString();
      return saveReview(row, changes);
    },

    async decline(companyId: string, reviewId: string, changeId: string): Promise<ModelSetupReview> {
      const row = await getReviewRow(companyId, reviewId);
      const changes = row.changes as unknown as ReviewChange[];
      const change = changes.find((c) => c.id === changeId);
      if (!change) throw notFound("Change not found");
      if (change.status !== "proposed") throw conflict(`This change is already ${change.status}.`);
      change.status = "declined";
      change.decidedAt = new Date().toISOString();
      return saveReview(row, changes);
    },

    /** One-click undo: restores the exact recorded before-state, but only if nothing changed it since. */
    async undo(companyId: string, reviewId: string, changeId: string, userId: string | null): Promise<ModelSetupReview> {
      const row = await getReviewRow(companyId, reviewId);
      const changes = row.changes as unknown as ReviewChange[];
      const change = changes.find((c) => c.id === changeId);
      if (!change) throw notFound("Change not found");
      if (change.status !== "applied") throw conflict(`This change is ${change.status}, so there is nothing to undo.`);
      if (!sameState(await stateOf(companyId, row.entryId), change.after)) {
        throw conflict("This setup was changed again after this fix. Undo the newer change first.");
      }
      await writeState(companyId, row.entryId, change.before, userId);
      change.status = "undone";
      change.decidedAt = new Date().toISOString();
      return saveReview(row, changes);
    },
  };
}

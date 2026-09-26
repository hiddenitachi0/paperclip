import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueThreadInteractions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { buildAbandonedPendingWhere, resolveInteractionExpiryRule } from "./issue-thread-interactions.js";

/**
 * Query-level check for the scheduler's card-expiry sweep, on real Postgres
 * with every migration applied (0176 included). The old implementation
 * computed one flat 24h cutoff in SQL and so also loaded (and closed) the
 * checklist cards a board user had filed for themselves. The WHERE built by
 * buildAbandonedPendingWhere must return exactly the rows the per-card rule
 * (resolveInteractionExpiryRule) says are due, and nothing else.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping card-expiry query test: ${support.reason ?? "unsupported environment"}`);
}

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-09-25T08:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);

type Seeded = {
  id: string;
  label: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  expiresAfterHours: number | null;
  neverExpires: boolean;
  createdAt: Date;
  status: string;
};

d("buildAbandonedPendingWhere (embedded Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seeded: Seeded[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-card-expiry-query-");
    db = createDb(tempDb.connectionString);

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Card expiry", issuePrefix });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "active",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Operator to-do list",
      status: "in_review",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const rows: Array<Omit<Seeded, "id">> = [
      // The live case: the operator's own checklist cards, re-posted (-r2), no limit of their own.
      { label: "operator checklist 48h old", createdByAgentId: null, createdByUserId: "user-filip", expiresAfterHours: null, neverExpires: false, createdAt: hoursAgo(48), status: "pending" },
      { label: "operator checklist 2000h old", createdByAgentId: null, createdByUserId: "user-filip", expiresAfterHours: null, neverExpires: false, createdAt: hoursAgo(2000), status: "pending" },
      // Agent cards on the instance default.
      { label: "agent card 25h old", createdByAgentId: agentId, createdByUserId: null, expiresAfterHours: null, neverExpires: false, createdAt: hoursAgo(25), status: "pending" },
      { label: "agent card 23h old", createdByAgentId: agentId, createdByUserId: null, expiresAfterHours: null, neverExpires: false, createdAt: hoursAgo(23), status: "pending" },
      // Own limit, either creator.
      { label: "operator card, own 2h limit, 3h old", createdByAgentId: null, createdByUserId: "user-filip", expiresAfterHours: 2, neverExpires: false, createdAt: hoursAgo(3), status: "pending" },
      { label: "operator card, own 2h limit, 1h old", createdByAgentId: null, createdByUserId: "user-filip", expiresAfterHours: 2, neverExpires: false, createdAt: hoursAgo(1), status: "pending" },
      { label: "agent card, own 48h limit, 30h old", createdByAgentId: agentId, createdByUserId: null, expiresAfterHours: 48, neverExpires: false, createdAt: hoursAgo(30), status: "pending" },
      // Explicit never.
      { label: "agent card, never, 100h old", createdByAgentId: agentId, createdByUserId: null, expiresAfterHours: null, neverExpires: true, createdAt: hoursAgo(100), status: "pending" },
      // No recorded creator: not a board user's card, so the agent default applies.
      { label: "no creator, 25h old", createdByAgentId: null, createdByUserId: null, expiresAfterHours: null, neverExpires: false, createdAt: hoursAgo(25), status: "pending" },
      // Already answered: never touched, however old.
      { label: "agent card, accepted, 100h old", createdByAgentId: agentId, createdByUserId: null, expiresAfterHours: null, neverExpires: false, createdAt: hoursAgo(100), status: "accepted" },
    ];
    for (const row of rows) {
      const id = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id,
        companyId,
        issueId,
        kind: "request_checkbox_confirmation",
        status: row.status,
        continuationPolicy: "wake_assignee",
        idempotencyKey: `${row.label}-r2`,
        title: row.label,
        createdByAgentId: row.createdByAgentId,
        createdByUserId: row.createdByUserId,
        expiresAfterHours: row.expiresAfterHours,
        neverExpires: row.neverExpires,
        payload: { version: 1, prompt: "Tick what is done", options: [{ id: "a", label: "A" }] },
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      });
      seeded.push({ id, ...row });
    }
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function dueLabels(agentDefaultHours: number): Promise<string[]> {
    const rows = await db
      .select({ title: issueThreadInteractions.title })
      .from(issueThreadInteractions)
      .where(buildAbandonedPendingWhere(NOW, agentDefaultHours))
      .limit(50);
    return rows.map((row) => row.title ?? "").sort();
  }

  it("with the 24h default: loads the due agent cards and the operator card whose own limit ran out, never an operator card without a limit", async () => {
    expect(await dueLabels(24)).toEqual([
      "agent card 25h old",
      "no creator, 25h old",
      "operator card, own 2h limit, 3h old",
    ]);
  });

  it("with the setting raised to 48h: the 25h-old agent card is no longer due, the operator card with its own limit still is", async () => {
    expect(await dueLabels(48)).toEqual(["operator card, own 2h limit, 3h old"]);
  });

  it("agrees row for row with resolveInteractionExpiryRule (the in-code half of the rule)", async () => {
    for (const agentDefaultHours of [24, 48, 1]) {
      const fromSql = new Set(await dueLabels(agentDefaultHours));
      for (const row of seeded) {
        const rule = resolveInteractionExpiryRule(row, agentDefaultHours);
        const dueInCode =
          row.status === "pending"
          && rule.kind !== "never"
          && row.createdAt.getTime() + rule.hours * HOUR_MS <= NOW.getTime();
        expect(fromSql.has(row.label), `${row.label} @ default ${agentDefaultHours}h`).toBe(dueInCode);
      }
    }
  });
});

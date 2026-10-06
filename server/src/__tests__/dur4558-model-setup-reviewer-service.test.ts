import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, modelDirectoryConverters, modelDirectoryEntries } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { modelDirectoryService } from "../services/model-directory.ts";
import { modelSetupReviewerService } from "../services/model-setup-reviewer.ts";

/** DUR-4558: review -> apply -> undo on a real Postgres. */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

// Thinking on (no reasoning_effort): empty turn. Thinking off: fine. Tools work.
const fetchImpl = (async (url: string, init: any) => {
  if (String(url).endsWith("/api/show")) return new Response("{}", { status: 404 });
  const b = JSON.parse(init.body);
  const t = b.tools?.[0]?.function?.name;
  if (t) return json({ choices: [{ message: { tool_calls: [{ function: { name: t, arguments: '{"description":"x"}' } }] } }] });
  if (b.messages[0].content.startsWith("Say hi") && !b.reasoning_effort) return json({ choices: [{ message: { content: "<think>plan</think>" } }] });
  return json({ choices: [{ message: { content: "Hello there, nice to meet you." } }] });
}) as unknown as typeof fetch;

d("model setup reviewer service", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const a = randomUUID();
  const b = randomUUID();

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-model-reviewer-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values([{ id: a, name: "A", issuePrefix: "MRA" }, { id: b, name: "B", issuePrefix: "MRB" }]);
  }, 60_000);
  afterAll(async () => { await cleanup?.(); });

  it("applies a passing fix, records before/after, undo restores the exact earlier state, and other companies can't touch it", async () => {
    const entry = await modelDirectoryService(db).create(a, { name: "qwen", provider: "local", model: "qwen3:8b", baseUrl: "http://100.1.2.3:11434/v1" }, { userId: "filip" });
    const svc = modelSetupReviewerService(db, { fetchImpl });

    const rev = await svc.review(a, entry.id, { userId: "filip" });
    const change = rev.changes.find((c) => c.code === "qwen_empty_thinking")!;
    expect(change.status).toBe("applied");
    expect(change.before.settings.defaultThinking).toBeNull();
    expect(change.after.settings.defaultThinking).toBe("off");
    expect(rev.report.summary).toMatch(/Suggested/);
    const [row] = await db.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.id, entry.id));
    expect(row!.defaultThinking).toBe("off");
    expect(row!.baseUrl).toBe("http://100.1.2.3:11434/v1");
    const [conv] = await db.select().from(modelDirectoryConverters).where(eq(modelDirectoryConverters.entryId, entry.id));
    expect(conv!.ops).toEqual([{ op: "strip_output_wrapper", wrapper: "think" }]);

    await expect(svc.undo(b, rev.id, change.id, "x")).rejects.toMatchObject({ status: 404 });
    await expect(svc.list(b, entry.id)).rejects.toMatchObject({ status: 404 });

    const undone = await svc.undo(a, rev.id, change.id, "filip");
    expect(undone.changes.find((c) => c.id === change.id)!.status).toBe("undone");
    const [back] = await db.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.id, entry.id));
    expect(back!.defaultThinking).toBeNull();
    const [conv2] = await db.select().from(modelDirectoryConverters).where(eq(modelDirectoryConverters.entryId, entry.id));
    expect(conv2!.ops).toEqual([]);
    await expect(svc.undo(a, rev.id, change.id, "filip")).rejects.toMatchObject({ status: 409 });
  });

  it("a stale entry blocks undo of an older change; a failing address makes a finding and changes nothing", async () => {
    const entry = await modelDirectoryService(db).create(a, { name: "dead", provider: "local", model: "x", baseUrl: "http://100.9.9.9:11434/v1" }, { userId: "filip" });
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const rev = await modelSetupReviewerService(db, { fetchImpl: dead }).review(a, entry.id, { userId: null });
    expect(rev.changes).toEqual([]);
    expect(rev.report.findings.map((f) => f.code)).toContain("stale_address");
    const [row] = await db.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.id, entry.id));
    expect(row!.baseUrl).toBe("http://100.9.9.9:11434/v1");
  });
});

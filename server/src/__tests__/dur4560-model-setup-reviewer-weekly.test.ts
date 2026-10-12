import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { modelDirectoryService } from "../services/model-directory.ts";
import {
  MODEL_SETUP_REVIEWER_PERSONA,
  MODEL_SETUP_REVIEW_INTERVAL_MS,
  assertReviewerWriteScope,
  modelSetupReviewerService,
} from "../services/model-setup-reviewer.ts";

/** DUR-4560: the weekly routine and the reviewer's hard write scope. */

describe("reviewer persona scope", () => {
  it("allows only the three model-directory targets and refuses everything else", () => {
    for (const ok of MODEL_SETUP_REVIEWER_PERSONA.mayWrite) expect(() => assertReviewerWriteScope(ok)).not.toThrow();
    for (const bad of ["agents", "secrets", "budgets", "model_directory_entries.base_url", "host_allow_list", "code"]) {
      expect(() => assertReviewerWriteScope(bad)).toThrow();
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const fetchImpl = (async (url: string) => {
  if (String(url).endsWith("/api/show")) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify({ choices: [{ message: { content: "Hello there, nice to meet you." } }] }), { status: 200 });
}) as unknown as typeof fetch;

d("weekly model setup review", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const a = randomUUID();
  const b = randomUUID();

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-model-reviewer-weekly-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values([{ id: a, name: "A", issuePrefix: "MWA" }, { id: b, name: "B", issuePrefix: "MWB" }]);
  }, 60_000);
  afterAll(async () => { await cleanup?.(); });

  it("reviews each local setup once a week, skips cloud ones, stays in its own company", async () => {
    const dir = modelDirectoryService(db);
    const local = await dir.create(a, { name: "l", provider: "local", model: "m", baseUrl: "http://100.1.2.3:11434/v1" }, { userId: "f" });
    await dir.create(a, { name: "c", provider: "openrouter", model: "x/y" }, { userId: "f" });
    await dir.create(b, { name: "other", provider: "local", model: "m", baseUrl: "http://100.1.2.4:11434/v1" }, { userId: "f" });
    const svc = modelSetupReviewerService(db, { fetchImpl });
    const now = new Date();

    expect(await svc.reviewDue(a, now)).toEqual({ reviewed: 1, failed: 0 });
    const list = await svc.list(a, local.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.trigger).toBe("weekly");

    expect(await svc.reviewDue(a, new Date(now.getTime() + 60_000))).toEqual({ reviewed: 0, failed: 0 });
    expect(await svc.reviewDue(a, new Date(now.getTime() + MODEL_SETUP_REVIEW_INTERVAL_MS + 60_000))).toEqual({ reviewed: 1, failed: 0 });
    expect(await svc.list(a, local.id)).toHaveLength(2);
  });
});

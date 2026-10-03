import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { modelDirectoryService } from "../services/model-directory.ts";

/** DUR-4379: model directory service on a real Postgres with every migration applied. */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("model directory service", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof modelDirectoryService>;
  const a = randomUUID();
  const b = randomUUID();
  const actor = { userId: "filip" };
  const local = { name: "Local llama", provider: "local" as const, model: "llama3.1", baseUrl: "http://localhost:11434/v1" };

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-model-directory-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    svc = modelDirectoryService(db);
    await db.insert(companies).values([
      { id: a, name: "A", issuePrefix: "MDA" },
      { id: b, name: "B", issuePrefix: "MDB" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("creates, lists and reads within a company, and never across companies", async () => {
    const created = await svc.create(a, { ...local, defaultThinking: "off", defaultTemperature: 0.6 }, actor);
    expect(created).toMatchObject({ companyId: a, createdByUserId: "filip", defaultThinking: "off", backupEntryIds: [] });
    expect(JSON.stringify(created)).not.toMatch(/key/i);
    expect((await svc.list(a)).map((e) => e.id)).toEqual([created.id]);
    expect(await svc.list(b)).toEqual([]);
    await expect(svc.get(b, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.update(b, created.id, { note: "x" }, actor)).rejects.toMatchObject({ status: 404 });
    await expect(svc.remove(b, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.duplicate(b, created.id, undefined, actor)).rejects.toMatchObject({ status: 404 });
    expect((await svc.get(a, created.id)).note).toBeNull();
  });

  it("allows the same name in two companies but not twice in one", async () => {
    await svc.create(b, local, actor);
    await expect(svc.create(a, local, actor)).rejects.toMatchObject({ status: 409 });
  });

  it("validates updates against the merged row", async () => {
    const e = await svc.create(a, { name: "Claude", provider: "anthropic", model: "claude-sonnet-5" }, actor);
    await expect(svc.update(a, e.id, { providerRouting: { only: ["deepinfra"] } }, { userId: "x" })).rejects.toMatchObject({ status: 422 });
    await expect(svc.update(a, e.id, { provider: "local" }, actor)).rejects.toMatchObject({ status: 422 });
    await expect(svc.update(a, e.id, { backupEntryIds: [e.id] }, actor)).rejects.toMatchObject({ status: 422 });
    await expect(svc.update(a, e.id, { name: "Local llama" }, actor)).rejects.toMatchObject({ status: 409 });
    const updated = await svc.update(a, e.id, { note: "main", defaultThinking: "on" }, { userId: "other" });
    expect(updated).toMatchObject({ note: "main", defaultThinking: "on", createdByUserId: "filip", updatedByUserId: "other" });
  });

  it("only accepts backups from the same company, and deleting an entry drops it from chains", async () => {
    const mine = await svc.create(a, { name: "Backup A", provider: "anthropic", model: "claude-sonnet-5" }, actor);
    const theirs = await svc.create(b, { name: "Backup B", provider: "anthropic", model: "claude-sonnet-5" }, actor);
    await expect(
      svc.create(a, { name: "Chain bad", provider: "anthropic", model: "claude-sonnet-5", backupEntryIds: [theirs.id] }, actor),
    ).rejects.toMatchObject({ status: 422 });
    const chained = await svc.create(a, { name: "Chain", provider: "anthropic", model: "claude-sonnet-5", backupEntryIds: [mine.id] }, actor);
    await svc.remove(a, mine.id);
    expect((await svc.get(a, chained.id)).backupEntryIds).toEqual([]);
    expect((await svc.list(b)).some((e) => e.id === theirs.id)).toBe(true);
  });

  it("duplicates with a fresh unique name", async () => {
    const src = (await svc.list(a)).find((e) => e.name === "Local llama")!;
    const one = await svc.duplicate(a, src.id, undefined, actor);
    const two = await svc.duplicate(a, src.id, undefined, actor);
    expect([one.name, two.name]).toEqual(["Local llama (copy)", "Local llama (copy 2)"]);
    expect(one).toMatchObject({ provider: "local", model: "llama3.1", baseUrl: src.baseUrl });
    expect(one.id).not.toBe(src.id);
    await expect(svc.duplicate(a, src.id, "Local llama", actor)).rejects.toMatchObject({ status: 409 });
    expect((await svc.duplicate(a, src.id, "Custom", actor)).name).toBe("Custom");
  });
});

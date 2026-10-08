import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { MODEL_DIRECTORY_STARTERS, modelDirectoryEntryIssue } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { modelDirectoryService, resolveBackupModelsThroughDirectory } from "../services/model-directory.ts";

/** DUR-4418: starters, import of today's manual settings, and backups through the directory. */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("model directory starters and settings import", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof modelDirectoryService>;
  const a = randomUUID();
  const b = randomUUID();
  const actor = { userId: "filip" };
  const base = { role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} } as const;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-model-directory-import-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    svc = modelDirectoryService(db);
    await db.insert(companies).values([
      { id: a, name: "A", issuePrefix: "MIA" },
      { id: b, name: "B", issuePrefix: "MIB" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("creates the starters company-scoped, without a key, and is safe to repeat", async () => {
    const first = await svc.addStarters(a, undefined, actor);
    expect(first.length).toBe(MODEL_DIRECTORY_STARTERS.length);
    expect(first.every((e) => e.companyId === a)).toBe(true);
    expect(first.find((e) => e.model.includes("mistral-small-3.2"))).toMatchObject({ provider: "openrouter", baseUrl: null });
    // Catalogue fields and defaults travel with the starter.
    expect(first.find((e) => e.model === "qwen/qwen3.8-27b")).toMatchObject({
      maker: "Alibaba Qwen",
      lane: "both",
      availability: "cloud",
      providerRouting: { only: ["deepinfra", "parasail", "novita"] },
      defaultTemperature: 0.7,
    });
    expect(JSON.stringify(first)).not.toMatch(/apiKey|secret/i);
    expect(await svc.addStarters(a, undefined, actor)).toEqual([]);
    expect(await svc.list(b)).toEqual([]);
    expect((await svc.listStarters(a)).every((s) => s.alreadyAdded)).toBe(true);
    expect((await svc.listStarters(b)).every((s) => !s.alreadyAdded)).toBe(true);
    await expect(svc.addStarters(b, ["nope"], actor)).rejects.toMatchObject({ status: 422 });
  });

  it("ships tool-capable Hugging Face starters that pass entry validation", () => {
    const hf = MODEL_DIRECTORY_STARTERS.filter((s) => s.provider === "huggingface");
    expect(hf.map((s) => s.model)).toEqual([
      "huihui-ai/Huihui-Qwen3-14B-abliterated-v2:featherless-ai",
      "darkc0de/Qwen3.8-27B-heretic:featherless-ai",
    ]);
    for (const s of hf) {
      expect(s.baseUrl).toBeNull();
      expect(modelDirectoryEntryIssue({ provider: s.provider, model: s.model, baseUrl: s.baseUrl })).toBeNull();
    }
  });

  it("de-duplicates identical manual setups, links agents, and leaves their live settings alone", async () => {
    const setup = {
      laneAProvider: "openrouter",
      laneAModel: "vendor/some-model",
      laneAProviderRouting: { only: ["deepinfra"] },
      laneAThinking: "off",
      laneATemperature: 0.7,
      laneAMaxOutputTokens: 800,
    };
    const [x, y, z] = await db
      .insert(agents)
      .values([
        { ...base, companyId: b, name: "X", laneAEnabled: true, ...setup },
        { ...base, companyId: b, name: "Y", laneAEnabled: true, ...setup },
        { ...base, companyId: b, name: "Z", laneAEnabled: true, ...setup, laneATemperature: 0.2 },
      ])
      .returning();
    const [plain] = await db.insert(agents).values({ ...base, companyId: b, name: "Plain" }).returning();
    const before = await db.select().from(agents).where(eq(agents.companyId, b));

    const result = await svc.importAgentSettings(b, actor);
    expect(result.created).toHaveLength(2);
    expect(result.agentsLinked).toBe(3);
    expect(result.skipped).toEqual([]);

    const after = await db.select().from(agents).where(eq(agents.companyId, b));
    const strip = (r: (typeof after)[number]) => ({ ...r, laneADirectoryEntryId: null });
    expect(after.map(strip)).toEqual(before.map(strip));
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(x!.id)!.laneADirectoryEntryId).toBeTruthy();
    expect(byId.get(x!.id)!.laneADirectoryEntryId).toBe(byId.get(y!.id)!.laneADirectoryEntryId);
    expect(byId.get(z!.id)!.laneADirectoryEntryId).not.toBe(byId.get(x!.id)!.laneADirectoryEntryId);
    expect(byId.get(plain!.id)!.laneADirectoryEntryId).toBeNull();
    expect(result.created.find((e) => e.id === byId.get(x!.id)!.laneADirectoryEntryId)).toMatchObject({
      companyId: b,
      provider: "openrouter",
      model: "vendor/some-model",
      defaultThinking: "off",
      defaultTemperature: 0.7,
      defaultMaxOutputTokens: 800,
      providerRouting: { only: ["deepinfra"] },
    });

    const again = await svc.importAgentSettings(b, actor);
    expect(again).toEqual({ created: [], agentsLinked: 0, skipped: [] });
    expect(await svc.list(a)).not.toContainEqual(expect.objectContaining({ model: "vendor/some-model" }));
  });

  it("points backups at directory entries and resolves them through the entry", async () => {
    const [agent] = await db
      .insert(agents)
      .values({
        ...base,
        companyId: a,
        name: "Backups",
        laneAEnabled: true,
        laneABackupModels: [{ id: "bk1", provider: "local", model: "llama3.2", baseUrl: "http://100.124.232.68:11434/v1", temperature: 0.4 }],
      })
      .returning();
    const result = await svc.importAgentSettings(a, actor);
    expect(result.created.map((e) => e.model)).toEqual(["llama3.2"]);
    const [row] = await db.select().from(agents).where(eq(agents.id, agent!.id));
    const backup = (row!.laneABackupModels as { directoryEntryId?: string }[])[0]!;
    expect(backup.directoryEntryId).toBeTruthy();

    const entry = await svc.get(a, backup.directoryEntryId!);
    await svc.update(a, entry.id, { model: "llama3.3", defaultTemperature: 0.9 }, actor);
    const resolved = await resolveBackupModelsThroughDirectory(db, a, row!.laneABackupModels as never);
    expect(resolved[0]).toMatchObject({ id: "bk1", model: "llama3.3", temperature: 0.9, provider: "local" });

    // another company never resolves it: the inline copy is kept
    const crossCompany = await resolveBackupModelsThroughDirectory(db, b, row!.laneABackupModels as never);
    expect(crossCompany[0]).toMatchObject({ model: "llama3.2", temperature: 0.4 });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, modelDirectoryEntries } from "@paperclipai/db";
import {
  MODEL_DIRECTORY_STARTERS,
  createModelDirectoryEntrySchema,
  importModelDirectoryCatalogueSchema,
  updateModelDirectoryEntrySchema,
  type ImportModelDirectoryCatalogue,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { modelDirectoryService } from "../services/model-directory.ts";

/**
 * Settings > Models as a catalogue: the catalogue fields round-trip, archive
 * hides an entry from the default list, the list is in catalogue order, and a
 * catalogue file exports and imports (create / skip / update, backups by
 * name) inside one company only. Real Postgres with every migration applied.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const create = (input: unknown) => createModelDirectoryEntrySchema.parse(input);
const patch = (input: unknown) => updateModelDirectoryEntrySchema.parse(input);
const file = (input: unknown) => importModelDirectoryCatalogueSchema.parse(input);

d("model directory catalogue service", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof modelDirectoryService>;
  const actor = { userId: "filip" };
  const local = { provider: "local", baseUrl: "http://100.124.232.68:11434/v1" } as const;

  async function newCompany(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: prefix, issuePrefix: prefix });
    return id;
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-model-directory-catalogue-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    svc = modelDirectoryService(db);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("saves and returns every catalogue field, with sensible defaults", async () => {
    const c = await newCompany("CTA");
    const full = await svc.create(
      c,
      create({
        ...local,
        name: "Gemma 4 12B (local)",
        model: "gemma4:12b",
        maker: "  Google ",
        baseModel: "Gemma 4 12B",
        lane: "quick",
        availability: "installed",
        tags: ["Vision", "vision", "fast"],
        specs: { params: "12B", quant: "Q4_K_M", sizeGb: 8.1, contextTokens: 131072, fitsLocalGpu: "yes", tools: "yes", vision: true, pullCommand: "ollama pull gemma4:12b" },
        favorite: true,
      }),
      actor,
    );
    expect(full).toMatchObject({
      maker: "Google",
      baseModel: "Gemma 4 12B",
      lane: "quick",
      availability: "installed",
      tags: ["vision", "fast"],
      specs: { params: "12B", sizeGb: 8.1, fitsLocalGpu: "yes", vision: true, pullCommand: "ollama pull gemma4:12b" },
      favorite: true,
      archivedAt: null,
    });
    expect(await svc.get(c, full.id)).toEqual(full);

    const bare = await svc.create(c, create({ name: "Claude", provider: "anthropic", model: "claude-sonnet-5", maker: "  " }), actor);
    expect(bare).toMatchObject({ maker: null, baseModel: null, lane: null, availability: null, tags: [], specs: null, favorite: false, archivedAt: null });

    const updated = await svc.update(c, bare.id, patch({ maker: "Anthropic", lane: "both", availability: "cloud", tags: ["Coding"], specs: { contextTokens: 200000 }, favorite: true }), actor);
    expect(updated).toMatchObject({ maker: "Anthropic", lane: "both", availability: "cloud", tags: ["coding"], specs: { contextTokens: 200000 }, favorite: true });
    const cleared = await svc.update(c, bare.id, patch({ maker: null, lane: null, specs: null, tags: [], favorite: false }), actor);
    expect(cleared).toMatchObject({ maker: null, lane: null, specs: null, tags: [], favorite: false, availability: "cloud" });
  });

  it("archives and restores: hidden from the default list, kept and listed on request", async () => {
    const c = await newCompany("CTB");
    const keep = await svc.create(c, create({ name: "Keep", provider: "anthropic", model: "claude-sonnet-5" }), actor);
    const old = await svc.create(c, create({ name: "Old", provider: "anthropic", model: "claude-sonnet-5" }), actor);

    const archived = await svc.update(c, old.id, patch({ archived: true }), actor);
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect((await svc.list(c)).map((e) => e.name)).toEqual(["Keep"]);
    expect((await svc.list(c, { includeArchived: true })).map((e) => e.name)).toEqual(["Keep", "Old"]);
    expect((await svc.get(c, old.id)).archivedAt).toBe(archived.archivedAt);

    // Archiving again keeps the first time; other edits leave it alone.
    const again = await svc.update(c, old.id, patch({ archived: true, note: "still old" }), actor);
    expect(again.archivedAt).toBe(archived.archivedAt);
    expect((await svc.update(c, old.id, patch({ note: "x" }), actor)).archivedAt).toBe(archived.archivedAt);

    const restored = await svc.update(c, old.id, patch({ archived: false }), actor);
    expect(restored.archivedAt).toBeNull();
    expect((await svc.list(c)).map((e) => e.id)).toEqual([keep.id, old.id]);

    // An archived entry still blocks its name (unique index).
    await svc.update(c, old.id, patch({ archived: true }), actor);
    await expect(svc.create(c, create({ name: "Old", provider: "anthropic", model: "claude-sonnet-5" }), actor)).rejects.toMatchObject({ status: 409 });
  });

  it("lists favourites first, then maker, base model and name, case-insensitive with blanks last", async () => {
    const c = await newCompany("CTC");
    const add = (name: string, extra: Record<string, unknown> = {}) =>
      svc.create(c, create({ name, provider: "anthropic", model: "claude-sonnet-5", ...extra }), actor);
    await add("zeta loose");
    await add("Alpha loose");
    await add("Qwen3 14B", { maker: "Alibaba", baseModel: "Qwen3 14B" });
    await add("Qwen3 8B", { maker: "alibaba", baseModel: "Qwen3 8B" });
    await add("gemma b", { maker: "Google", baseModel: "gemma 4" });
    await add("Gemma a", { maker: "google", baseModel: "Gemma 4" });
    await add("Gemma no base", { maker: "Google" });
    await add("Pinned", { maker: "Zhipu", favorite: true });
    await add("Pinned loose", { favorite: true });
    expect((await svc.list(c)).map((e) => e.name)).toEqual([
      "Pinned",
      "Pinned loose",
      "Qwen3 8B",
      "Qwen3 14B",
      "Gemma a",
      "gemma b",
      "Gemma no base",
      "Alpha loose",
      "zeta loose",
    ]);
  });

  it("duplicates the catalogue fields but starts the copy un-favourited and visible", async () => {
    const c = await newCompany("CTD");
    const src = await svc.create(
      c,
      create({ ...local, name: "Src", model: "qwen3:14b", maker: "Alibaba", baseModel: "Qwen3 14B", lane: "full", availability: "downloading", tags: ["tools"], specs: { quant: "Q4_K_M" }, favorite: true }),
      actor,
    );
    await svc.update(c, src.id, patch({ archived: true }), actor);
    const copy = await svc.duplicate(c, src.id, undefined, actor);
    expect(copy).toMatchObject({
      name: "Src (copy)",
      maker: "Alibaba",
      baseModel: "Qwen3 14B",
      lane: "full",
      availability: "downloading",
      tags: ["tools"],
      specs: { quant: "Q4_K_M" },
      favorite: false,
      archivedAt: null,
    });
  });

  it("counts archived entries as already added for starters and as taken names for the settings import", async () => {
    const c = await newCompany("CTE");
    const [first] = await svc.addStarters(c, [MODEL_DIRECTORY_STARTERS[0]!.id], actor);
    await svc.update(c, first!.id, patch({ archived: true }), actor);
    expect((await svc.listStarters(c)).find((s) => s.id === MODEL_DIRECTORY_STARTERS[0]!.id)?.alreadyAdded).toBe(true);
    expect(await svc.addStarters(c, [MODEL_DIRECTORY_STARTERS[0]!.id], actor)).toEqual([]);

    // An archived entry holds the name the import would pick; the import picks the next one.
    const taken = await svc.create(c, create({ name: "OpenRouter: vendor/a", provider: "anthropic", model: "claude-sonnet-5" }), actor);
    await svc.update(c, taken.id, patch({ archived: true }), actor);
    const base = { role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, companyId: c, laneAEnabled: true } as const;
    await db.insert(agents).values({ ...base, name: "A", laneAProvider: "openrouter", laneAModel: "vendor/a" });
    const result = await svc.importAgentSettings(c, actor);
    expect(result.created.map((e) => e.name)).toEqual(["OpenRouter: vendor/a (2)"]);

    // An identical setup links to a visible entry before an archived one.
    const visible = await svc.create(c, create({ name: "Visible", provider: "openrouter", model: "vendor/b" }), actor);
    const hidden = await svc.create(c, create({ name: "Hidden", provider: "openrouter", model: "vendor/b" }), actor);
    await svc.update(c, hidden.id, patch({ archived: true }), actor);
    const [agentB] = await db.insert(agents).values({ ...base, name: "B", laneAProvider: "openrouter", laneAModel: "vendor/b" }).returning();
    expect((await svc.importAgentSettings(c, actor)).created).toEqual([]);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentB!.id));
    expect(row!.laneADirectoryEntryId).toBe(visible.id);
  });

  it("exports the whole catalogue as a plain file: archived included, backups by name, no ids or people", async () => {
    const c = await newCompany("CTF");
    const backup = await svc.create(c, create({ name: "Mistral backup", provider: "openrouter", model: "mistralai/mistral-small-3.2-24b-instruct", providerRouting: { only: ["mistral"] } }), actor);
    const main = await svc.create(
      c,
      create({ ...local, name: "Main", model: "qwen3:14b", backupEntryIds: [backup.id], maker: "Alibaba", tags: ["tools"], specs: { params: "14B" }, favorite: true, defaultThinking: "off" }),
      actor,
    );
    const old = await svc.create(c, create({ name: "Old", provider: "anthropic", model: "claude-sonnet-5", note: "retired" }), actor);
    await svc.update(c, old.id, patch({ archived: true }), actor);

    const out = await svc.exportCatalogue(c, new Date("2026-10-08T09:00:00.000Z"));
    expect(out.version).toBe(1);
    expect(out.exportedAt).toBe("2026-10-08T09:00:00.000Z");
    expect(out.entries.map((e) => e.name)).toEqual(["Main", "Mistral backup", "Old"]);
    expect(out.entries[0]).toEqual({
      name: "Main",
      provider: "local",
      model: "qwen3:14b",
      baseUrl: local.baseUrl,
      providerRouting: null,
      defaultThinking: "off",
      defaultTemperature: null,
      defaultMaxOutputTokens: null,
      note: null,
      maker: "Alibaba",
      baseModel: null,
      lane: null,
      availability: null,
      tags: ["tools"],
      specs: { params: "14B" },
      favorite: true,
      backupNames: ["Mistral backup"],
      archived: false,
    });
    expect(out.entries[1]).toMatchObject({ providerRouting: { only: ["mistral"] }, backupNames: [], archived: false });
    expect(out.entries[2]).toMatchObject({ note: "retired", archived: true });

    const text = JSON.stringify(out);
    for (const secretish of [c, main.id, backup.id, old.id, "filip", "companyId", "createdAt", "updatedAt", "archivedAt", "backupEntryIds", "\"id\""]) {
      expect(text).not.toContain(secretish);
    }
    expect(text).not.toMatch(/apiKey|secret/i);
    // The file is a valid import.
    expect(() => importModelDirectoryCatalogueSchema.parse(out)).not.toThrow();
  });

  it("imports a file into another company: creates everything and resolves backups by name, even forward ones", async () => {
    const from = await newCompany("CTG");
    const to = await newCompany("CTH");
    const backup = await svc.create(from, create({ name: "Backup", provider: "openrouter", model: "vendor/backup" }), actor);
    const archived = await svc.create(from, create({ name: "Archived", provider: "anthropic", model: "claude-sonnet-5" }), actor);
    await svc.update(from, archived.id, patch({ archived: true }), actor);
    await svc.create(
      from,
      create({ ...local, name: "Main", model: "qwen3:14b", backupEntryIds: [backup.id, archived.id], maker: "Alibaba", baseModel: "Qwen3 14B", lane: "quick", availability: "installed", tags: ["tools"], specs: { sizeGb: 9.3 }, favorite: true }),
      actor,
    );
    const exported = await svc.exportCatalogue(from);
    // Main (favourite) is first in the file, so its backups are forward references.
    expect(exported.entries[0]!.name).toBe("Main");

    const outcome = await svc.importCatalogue(to, file(exported), { userId: "importer" });
    expect(outcome.result).toEqual({ created: ["Main", "Archived", "Backup"], updated: [], skipped: [] });
    expect(outcome.createdEntries.every((e) => e.companyId === to && e.createdByUserId === "importer")).toBe(true);

    const all = await svc.list(to, { includeArchived: true });
    const byName = new Map(all.map((e) => [e.name, e]));
    expect(byName.get("Main")).toMatchObject({
      provider: "local",
      model: "qwen3:14b",
      baseUrl: local.baseUrl,
      maker: "Alibaba",
      baseModel: "Qwen3 14B",
      lane: "quick",
      availability: "installed",
      tags: ["tools"],
      specs: { sizeGb: 9.3 },
      favorite: true,
      archivedAt: null,
      backupEntryIds: [byName.get("Backup")!.id, byName.get("Archived")!.id],
    });
    expect(byName.get("Archived")!.archivedAt).toEqual(expect.any(String));
    expect((await svc.list(to)).map((e) => e.name)).toEqual(["Main", "Backup"]);

    // Round trip: exporting the new company gives the same file.
    const again = await svc.exportCatalogue(to);
    expect(again.entries).toEqual(exported.entries);
    // The source company is untouched.
    expect((await svc.list(from, { includeArchived: true })).length).toBe(3);
  });

  it("skips a setup whose name already exists (any capitalisation) by default, without changing it", async () => {
    const c = await newCompany("CTI");
    const existing = await svc.create(c, create({ name: "Main", provider: "anthropic", model: "claude-sonnet-5", note: "mine" }), actor);
    const outcome = await svc.importCatalogue(
      c,
      file({ entries: [{ name: "main", provider: "openrouter", model: "vendor/x", note: "theirs" }, { name: "New", provider: "openrouter", model: "vendor/y" }] }),
      actor,
    );
    expect(outcome.result.created).toEqual(["New"]);
    expect(outcome.result.updated).toEqual([]);
    expect(outcome.result.skipped).toEqual([{ name: "main", reason: 'Not imported: a model setup named "Main" already exists.' }]);
    expect(await svc.get(c, existing.id)).toMatchObject({ name: "Main", provider: "anthropic", note: "mine" });
  });

  it("updates a same-name setup with onExisting update: keeps its name, applies the file's fields and archive state", async () => {
    const c = await newCompany("CTJ");
    const other = await svc.create(c, create({ name: "Other", provider: "anthropic", model: "claude-sonnet-5" }), actor);
    const main = await svc.create(
      c,
      create({ name: "Main", provider: "anthropic", model: "claude-sonnet-5", note: "keep me", backupEntryIds: [other.id], tags: ["old"] }),
      actor,
    );
    const outcome = await svc.importCatalogue(
      c,
      file({
        onExisting: "update",
        entries: [
          { name: "MAIN", provider: "openrouter", model: "vendor/new", maker: "Vendor", tags: ["New"], favorite: true, archived: true },
          { name: "Other", provider: "anthropic", model: "claude-sonnet-5", backupNames: [] },
        ],
      }),
      { userId: "importer" },
    );
    expect(outcome.result).toEqual({ created: [], updated: ["Main", "Other"], skipped: [] });
    const after = await svc.get(c, main.id);
    expect(after).toMatchObject({
      name: "Main",
      provider: "openrouter",
      model: "vendor/new",
      maker: "Vendor",
      tags: ["new"],
      favorite: true,
      note: "keep me", // not in the file: left alone
      backupEntryIds: [other.id], // no backupNames in the file: chain left alone
      updatedByUserId: "importer",
      createdByUserId: "filip",
    });
    expect(after.archivedAt).toEqual(expect.any(String));
    expect(outcome.updatedEntries.map((e) => e.id).sort()).toEqual([main.id, other.id].sort());

    // Archived again from a file keeps the first archive time; archived:false restores.
    await svc.importCatalogue(c, file({ onExisting: "update", entries: [{ name: "Main", provider: "openrouter", model: "vendor/new", archived: true }] }), actor);
    expect((await svc.get(c, main.id)).archivedAt).toBe(after.archivedAt);
    await svc.importCatalogue(c, file({ onExisting: "update", entries: [{ name: "Main", provider: "openrouter", model: "vendor/new", archived: false }] }), actor);
    expect((await svc.get(c, main.id)).archivedAt).toBeNull();

    // backupNames: [] clears a chain.
    await svc.importCatalogue(c, file({ onExisting: "update", entries: [{ name: "Main", provider: "openrouter", model: "vendor/new", backupNames: [] }] }), actor);
    expect((await svc.get(c, main.id)).backupEntryIds).toEqual([]);
  });

  it("does not update a setup into a combination that cannot be saved, and says why", async () => {
    const c = await newCompany("CTK");
    const routed = await svc.create(c, create({ name: "Routed", provider: "openrouter", model: "vendor/x", providerRouting: { only: ["deepinfra"] } }), actor);
    const outcome = await svc.importCatalogue(
      c,
      file({ onExisting: "update", entries: [{ name: "Routed", provider: "anthropic", model: "claude-sonnet-5" }] }),
      actor,
    );
    expect(outcome.result.updated).toEqual([]);
    expect(outcome.result.skipped).toEqual([{ name: "Routed", reason: "Not updated: Model host restrictions only apply to OpenRouter." }]);
    expect(await svc.get(c, routed.id)).toMatchObject({ provider: "openrouter", model: "vendor/x" });
  });

  it("leaves out unknown and self backups, reports them, and still saves the entry", async () => {
    const c = await newCompany("CTL");
    const existing = await svc.create(c, create({ name: "Existing", provider: "anthropic", model: "claude-sonnet-5" }), actor);
    const outcome = await svc.importCatalogue(
      c,
      file({
        entries: [
          { name: "Main", provider: "openrouter", model: "vendor/main", backupNames: ["Nope", "existing", "Main", "Second", "Also missing"] },
          { name: "Second", provider: "openrouter", model: "vendor/second" },
        ],
      }),
      actor,
    );
    expect(outcome.result.created).toEqual(["Main", "Second"]);
    expect(outcome.result.skipped).toEqual([
      {
        name: "Main",
        reason: 'Imported, but backups "Nope", "Also missing" were left out because no model setups have those names, and it was listed as its own backup, which was left out.',
      },
    ]);
    const main = (await svc.list(c)).find((e) => e.name === "Main")!;
    const second = (await svc.list(c)).find((e) => e.name === "Second")!;
    expect(main.backupEntryIds).toEqual([existing.id, second.id]);
  });

  it("imports in one transaction: a failure part-way saves nothing", async () => {
    const c = await newCompany("CTM");
    const bad = {
      entries: [
        { name: "Fine", provider: "anthropic", model: "claude-sonnet-5" },
        // Bypasses the request schema to hit the database's own check.
        { name: "Broken", provider: "anthropic", model: "claude-sonnet-5", lane: "sometimes" },
      ],
    } as unknown as ImportModelDirectoryCatalogue;
    await expect(svc.importCatalogue(c, bad, actor)).rejects.toThrow();
    expect(await svc.list(c, { includeArchived: true })).toEqual([]);
  });

  it("never reads or writes another company's catalogue", async () => {
    const a = await newCompany("CTN");
    const b = await newCompany("CTO");
    const mine = await svc.create(a, create({ name: "Shared name", provider: "anthropic", model: "claude-sonnet-5", note: "A's" }), actor);
    await svc.create(a, create({ name: "Only in A", provider: "anthropic", model: "claude-sonnet-5" }), actor);

    // B's import with the same name creates B's own entry and cannot see A's names for backups.
    const outcome = await svc.importCatalogue(
      b,
      file({ onExisting: "update", entries: [{ name: "Shared name", provider: "openrouter", model: "vendor/b", note: "B's", backupNames: ["Only in A"] }] }),
      actor,
    );
    expect(outcome.result.created).toEqual(["Shared name"]);
    expect(outcome.result.updated).toEqual([]);
    expect(outcome.result.skipped).toEqual([
      { name: "Shared name", reason: 'Imported, but backup "Only in A" was left out because no model setup has that name.' },
    ]);
    expect(await svc.get(a, mine.id)).toMatchObject({ provider: "anthropic", note: "A's" });
    const bRows = await db.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.companyId, b));
    expect(bRows.map((r) => [r.name, r.backupEntryIds])).toEqual([["Shared name", []]]);

    // Each export holds only its own company's entries.
    expect((await svc.exportCatalogue(a)).entries.map((e) => e.name).sort()).toEqual(["Only in A", "Shared name"]);
    expect((await svc.exportCatalogue(b)).entries.map((e) => e.note)).toEqual(["B's"]);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  MODEL_DIRECTORY_NEEDS_LOCAL_ADDRESS_MESSAGE,
  MODEL_DIRECTORY_STARTERS,
  createModelDirectoryEntrySchema,
  importModelDirectoryCatalogueSchema,
  updateModelDirectoryEntrySchema,
  updateModelDirectorySettingsSchema,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { localAddressKey, localSyncFailedMessage, modelDirectoryService, parseOllamaTags } from "../services/model-directory.ts";

/**
 * Catalogue v2: family / variant / ratings round-trip everywhere (create,
 * update, duplicate, export/import, starters), the per-company settings row,
 * and the local Ollama resync (stubbed fetch). Real Postgres, every migration.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const create = (input: unknown) => createModelDirectoryEntrySchema.parse(input);
const patch = (input: unknown) => updateModelDirectoryEntrySchema.parse(input);

describe("catalogue v2 validators and helpers (no database)", () => {
  it("accepts good ratings and refuses bad ones", () => {
    const ok = create({ name: "x", provider: "openrouter", model: "a/b", family: "Llama 3.2", variant: "3B", ratings: [{ criterion: "Tool calling", score: 7, note: "fine" }] });
    expect(ok.ratings).toEqual([{ criterion: "Tool calling", score: 7, note: "fine" }]);
    for (const bad of [
      [{ criterion: "Tools", score: 11 }],
      [{ criterion: "Tools", score: -1 }],
      [{ criterion: "Tools", score: 6.5 }],
      [{ criterion: "", score: 5 }],
      [{ criterion: "Tools", score: 5, extra: true }],
      Array.from({ length: 21 }, (_, i) => ({ criterion: `c${i}`, score: 5 })),
    ]) {
      expect(createModelDirectoryEntrySchema.safeParse({ name: "x", provider: "openrouter", model: "a/b", ratings: bad }).success).toBe(false);
      expect(updateModelDirectoryEntrySchema.safeParse({ ratings: bad }).success).toBe(false);
    }
  });

  it("settings take a number of GB or null, nothing else", () => {
    expect(updateModelDirectorySettingsSchema.safeParse({ localGpuVramGb: 12 }).success).toBe(true);
    expect(updateModelDirectorySettingsSchema.safeParse({ localGpuVramGb: null }).success).toBe(true);
    expect(updateModelDirectorySettingsSchema.safeParse({ localGpuVramGb: -1 }).success).toBe(false);
    expect(updateModelDirectorySettingsSchema.safeParse({ localGpuVramGb: 12, other: 1 }).success).toBe(false);
    expect(updateModelDirectorySettingsSchema.safeParse({ localBaseUrl: "http://192.168.1.20:11434/v1" }).success).toBe(true);
    expect(updateModelDirectorySettingsSchema.safeParse({ localBaseUrl: null }).success).toBe(true);
    expect(updateModelDirectorySettingsSchema.safeParse({ localBaseUrl: "192.168.1.20:11434" }).success).toBe(false);
    expect(updateModelDirectorySettingsSchema.safeParse({}).success).toBe(false);
    expect(updateModelDirectorySettingsSchema.parse({ openrouterBlockedHosts: ["Venice", "venice"] })).toEqual({ openrouterBlockedHosts: ["venice"] });
    expect(updateModelDirectorySettingsSchema.safeParse({ openrouterBlockedHosts: ["deep infra"] }).success).toBe(false);
    expect(updateModelDirectorySettingsSchema.safeParse({ openrouterBlockedHosts: ["deepinfra/fp8"] }).success).toBe(false);
    expect(updateModelDirectorySettingsSchema.safeParse({ openrouterBlockedHosts: Array.from({ length: 31 }, (_, i) => `h${i}`) }).success).toBe(false);
    expect(
      updateModelDirectorySettingsSchema.safeParse({ openrouterPreferredHosts: ["novita"], openrouterBlockedHosts: ["novita"] }).success,
    ).toBe(false);
  });

  it("normalises a local address: case, trailing slash and /v1 do not matter", () => {
    expect(localAddressKey("http://100.1.2.3:11434/v1/")).toBe("http://100.1.2.3:11434");
    expect(localAddressKey("HTTP://100.1.2.3:11434/")).toBe("http://100.1.2.3:11434");
    expect(localAddressKey("http://100.1.2.3:11434/V1")).toBe("http://100.1.2.3:11434");
  });

  it("parses Ollama's model list and refuses something that is not Ollama", () => {
    expect(parseOllamaTags({ hello: 1 })).toBeNull();
    expect(
      parseOllamaTags({
        models: [
          { name: "llama3.2:latest", size: 2019393189, details: { parameter_size: "3.2B", quantization_level: "Q4_K_M", family: "llama" } },
          { model: "phi4:latest" },
          { nope: true },
        ],
      }),
    ).toEqual([
      { name: "llama3.2:latest", sizeGb: 2, parameterSize: "3.2B", quantization: "Q4_K_M", family: "llama" },
      { name: "phi4:latest", sizeGb: null, parameterSize: null, quantization: null, family: null },
    ]);
  });

  it("every starter names its family and size", () => {
    for (const s of MODEL_DIRECTORY_STARTERS) {
      expect(s.family, s.id).toBeTruthy();
      expect(s.variant, s.id).toBeTruthy();
    }
  });
});

d("catalogue v2 service", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof modelDirectoryService>;
  const actor = { userId: "filip" };
  const pc = "http://100.124.232.68:11434/v1";
  const fetchStub = vi.fn();

  async function newCompany(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: prefix, issuePrefix: prefix });
    return id;
  }

  const tags = (names: string[]) =>
    new Response(
      JSON.stringify({
        models: names.map((name) => ({ name, model: name, size: 5_000_000_000, details: { parameter_size: "8B", quantization_level: "Q4_K_M", family: "qwen3" } })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-model-catalogue-v2-");
    cleanup = started.cleanup;
    db = createDb(started.connectionString);
    svc = modelDirectoryService(db, { fetchImpl: fetchStub as unknown as typeof fetch, now: () => new Date("2026-10-08T12:00:00.000Z") });
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("saves family, variant and ratings, and copies them on duplicate", async () => {
    const c = await newCompany("CVA");
    const made = await svc.create(
      c,
      create({ name: "Llama small", provider: "local", model: "llama3.2:3b", baseUrl: pc, family: " Llama 3.2 ", variant: "3B", ratings: [{ criterion: "Tool calling", score: 6 }] }),
      actor,
    );
    expect(made).toMatchObject({ family: "Llama 3.2", variant: "3B", ratings: [{ criterion: "Tool calling", score: 6 }] });
    expect(made.ratings[0]!.updatedAt).toBe("2026-10-08T12:00:00.000Z");

    const updated = await svc.update(c, made.id, patch({ variant: "", ratings: [{ criterion: "Speed", score: 9, note: "quick", updatedAt: "2026-10-01T00:00:00.000Z" }] }), actor);
    expect(updated).toMatchObject({ family: "Llama 3.2", variant: null, ratings: [{ criterion: "Speed", score: 9, note: "quick", updatedAt: "2026-10-01T00:00:00.000Z" }] });
    // Left alone when not in the patch.
    expect((await svc.update(c, made.id, patch({ note: "n" }), actor)).ratings).toHaveLength(1);

    const copy = await svc.duplicate(c, made.id, undefined, actor);
    expect(copy).toMatchObject({ family: "Llama 3.2", variant: null, ratings: [{ criterion: "Speed", score: 9 }] });

    const fresh = await svc.create(c, create({ name: "Plain", provider: "openrouter", model: "a/b" }), actor);
    expect(fresh).toMatchObject({ family: null, variant: null, ratings: [] });
  });

  it("exports and imports family, variant and ratings", async () => {
    const a = await newCompany("CVB");
    const b = await newCompany("CVC");
    await svc.create(a, create({ name: "Gemma", provider: "openrouter", model: "google/gemma-4-31b-it", family: "Gemma 4", variant: "31B", ratings: [{ criterion: "Norwegian", score: 9 }] }), actor);
    const file = await svc.exportCatalogue(a);
    expect(file.entries[0]).toMatchObject({ family: "Gemma 4", variant: "31B", ratings: [{ criterion: "Norwegian", score: 9 }] });
    const parsed = importModelDirectoryCatalogueSchema.parse(JSON.parse(JSON.stringify(file)));
    await svc.importCatalogue(b, parsed, actor);
    expect((await svc.list(b))[0]).toMatchObject({ family: "Gemma 4", variant: "31B", ratings: [{ criterion: "Norwegian", score: 9 }] });

    // Update mode overwrites the given fields.
    const changed = importModelDirectoryCatalogueSchema.parse({
      ...JSON.parse(JSON.stringify(file)),
      onExisting: "update",
      entries: [{ name: "Gemma", provider: "openrouter", model: "google/gemma-4-31b-it", variant: "31B it", ratings: [] }],
    });
    await svc.importCatalogue(b, changed, actor);
    expect((await svc.list(b))[0]).toMatchObject({ family: "Gemma 4", variant: "31B it", ratings: [] });
  });

  it("starters carry their family and size", async () => {
    const c = await newCompany("CVD");
    const cloud = MODEL_DIRECTORY_STARTERS.find((s) => s.provider !== "local")!;
    const { created: [first] } = await svc.addStarters(c, [cloud.id], actor);
    expect(first).toMatchObject({ family: cloud.family, variant: cloud.variant, ratings: [] });
  });

  it("local starters need the company's model server address; cloud ones are added anyway", async () => {
    const c = await newCompany("CVL");
    const local = MODEL_DIRECTORY_STARTERS.find((s) => s.provider === "local")!;
    const cloud = MODEL_DIRECTORY_STARTERS.find((s) => s.provider !== "local")!;
    // Only local asked for, no address: refused in plain words, nothing saved.
    await expect(svc.addStarters(c, [local.id], actor)).rejects.toMatchObject({ status: 422, message: MODEL_DIRECTORY_NEEDS_LOCAL_ADDRESS_MESSAGE });
    expect(await svc.list(c)).toEqual([]);
    // Mixed: the cloud one is added, the local one skipped with the reason.
    const mixed = await svc.addStarters(c, [local.id, cloud.id], actor);
    expect(mixed.created.map((e) => e.name)).toEqual([cloud.name]);
    expect(mixed.skipped).toEqual([{ starterId: local.id, name: local.name, reason: MODEL_DIRECTORY_NEEDS_LOCAL_ADDRESS_MESSAGE }]);
    // With the address set, the local one gets it and starts as planned.
    await svc.updateSettings(c, { localBaseUrl: "http://192.168.1.20:11434/v1" }, actor);
    const after = await svc.addStarters(c, [local.id, cloud.id], actor);
    expect(after.skipped).toEqual([]);
    expect(after.created).toHaveLength(1);
    expect(after.created[0]).toMatchObject({ name: local.name, provider: "local", baseUrl: "http://192.168.1.20:11434/v1", availability: "planned" });
    // Counts as added at any address from now on.
    expect((await svc.listStarters(c)).find((s) => s.id === local.id)!.alreadyAdded).toBe(true);
  });

  it("reads defaults, saves and re-saves settings (graphics memory and address), per company", async () => {
    const a = await newCompany("CVE");
    const b = await newCompany("CVF");
    const empty = { localGpuVramGb: null, localBaseUrl: null };
    expect(await svc.getSettings(a)).toMatchObject(empty);
    expect(await svc.updateSettings(a, { localGpuVramGb: 12 }, actor)).toMatchObject({ localGpuVramGb: 12, localBaseUrl: null });
    expect(await svc.updateSettings(a, { localGpuVramGb: 16.5 }, actor)).toMatchObject({ localGpuVramGb: 16.5, localBaseUrl: null });
    // Saving the address alone keeps the graphics memory, and the other way round.
    expect(await svc.updateSettings(a, { localBaseUrl: " http://192.168.1.20:11434/v1 " }, actor)).toMatchObject({ localGpuVramGb: 16.5, localBaseUrl: "http://192.168.1.20:11434/v1" });
    expect(await svc.updateSettings(a, { localGpuVramGb: 0 }, actor)).toMatchObject({ localGpuVramGb: 0, localBaseUrl: "http://192.168.1.20:11434/v1" });
    expect(await svc.getSettings(a)).toMatchObject({ localGpuVramGb: 0, localBaseUrl: "http://192.168.1.20:11434/v1" });
    expect(await svc.getSettings(b)).toMatchObject(empty);
    expect(await svc.updateSettings(a, { localGpuVramGb: null, localBaseUrl: null }, actor)).toMatchObject(empty);
  });

  it("saves the OpenRouter host rules, refuses a host on both lists, and blocks hosts on new setups", async () => {
    const c = await newCompany("CVOR");
    expect(await svc.getSettings(c)).toMatchObject({ openrouterPreferredHosts: [], openrouterBlockedHosts: [] });
    const saved = await svc.updateSettings(
      c,
      updateModelDirectorySettingsSchema.parse({ openrouterPreferredHosts: ["Novita", "parasail"], openrouterBlockedHosts: ["venice"] }),
      actor,
    );
    expect(saved).toMatchObject({ openrouterPreferredHosts: ["novita", "parasail"], openrouterBlockedHosts: ["venice"] });
    // Saving another field keeps the lists.
    expect(await svc.updateSettings(c, { localGpuVramGb: 8 }, actor)).toMatchObject({ openrouterBlockedHosts: ["venice"] });
    // A host on both lists is refused, also when only one list is sent.
    await expect(svc.updateSettings(c, { openrouterBlockedHosts: ["novita"] }, actor)).rejects.toMatchObject({ status: 422 });
    // A new OpenRouter setup gets the blocked host in its "never" list...
    const plain = await svc.create(c, create({ name: "Qwen cloud", provider: "openrouter", model: "qwen/qwen3.8-27b" }), actor);
    expect(plain.providerRouting).toEqual({ ignore: ["venice"] });
    // ...unless it marks that host "Use" itself (an explicit exception).
    const exception = await svc.create(
      c,
      create({ name: "Venice on purpose", provider: "openrouter", model: "qwen/qwen3.8-27b", providerRouting: { only: ["venice"] } }),
      actor,
    );
    expect(exception.providerRouting).toEqual({ only: ["venice"] });
    // Not OpenRouter: nothing to block.
    await svc.updateSettings(c, { localBaseUrl: "http://192.168.1.20:11434/v1" }, actor);
    const local = await svc.create(c, create({ name: "Local", provider: "local", model: "qwen3:14b", baseUrl: "http://192.168.1.20:11434/v1" }), actor);
    expect(local.providerRouting).toBeNull();
    // Ready-made cloud setups get it too, and none of them picks a host itself.
    const cloud = MODEL_DIRECTORY_STARTERS.find((s) => s.provider === "openrouter" && s.model !== "qwen/qwen3.8-27b")!;
    const { created } = await svc.addStarters(c, [cloud.id], actor);
    expect(created[0]!.providerRouting).toEqual({ ignore: ["venice"] });
  });

  it("resyncs at the company's model server address even with no saved local model", async () => {
    const c = await newCompany("CVM");
    fetchStub.mockReset();
    await expect(svc.syncLocalModels(c, "http://192.168.1.20:11434/v1")).rejects.toMatchObject({ status: 422 });
    expect(fetchStub).not.toHaveBeenCalled();
    await svc.updateSettings(c, { localBaseUrl: "http://192.168.1.20:11434/v1" }, actor);
    fetchStub.mockResolvedValue(tags(["qwen3:14b"]));
    const result = await svc.syncLocalModels(c, "http://192.168.1.20:11434");
    expect(fetchStub.mock.calls[0]![0]).toBe("http://192.168.1.20:11434/api/tags");
    expect(fetchStub.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(result).toMatchObject({ baseUrl: "http://192.168.1.20:11434/v1", installed: [{ name: "qwen3:14b", entryIds: [] }] });
  });

  it("marks local entries installed / planned from Ollama's list, only at that address and in this company", async () => {
    const c = await newCompany("CVG");
    const other = await newCompany("CVH");
    const mk = (name: string, model: string, availability: string | null, baseUrl = pc, company = c) =>
      svc.create(company, create({ name, provider: "local", model, baseUrl, ...(availability ? { availability } : {}) }), actor);
    const bare = await mk("Llama bare", "llama3.2", "planned"); // listed as llama3.2:latest
    const latest = await mk("Phi", "phi4:latest", null); // listed as phi4
    const gone = await mk("Qwen gone", "qwen3:14b", "installed");
    const stillDownloading = await mk("Gemma pulling", "gemma4:e4b", "downloading");
    const doneDownloading = await mk("Hermes", "hermes3:8b", "downloading");
    const already = await mk("Already", "qwen3:8b", "installed");
    const elsewhere = await mk("Other PC", "qwen3:14b", "installed", "http://100.9.9.9:11434/v1");
    const otherCompany = await mk("Theirs", "qwen3:14b", "installed", pc, other);

    fetchStub.mockReset();
    fetchStub.mockResolvedValue(tags(["llama3.2:latest", "phi4", "hermes3:8b", "qwen3:8b", "mistral-nemo:12b"]));
    const result = await svc.syncLocalModels(c, "http://100.124.232.68:11434/");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]![0]).toBe("http://100.124.232.68:11434/api/tags");
    expect(result.baseUrl).toBe(pc);
    expect(result.checkedAt).toBe("2026-10-08T12:00:00.000Z");
    expect(new Set(result.markedInstalledEntryIds)).toEqual(new Set([bare.id, latest.id, doneDownloading.id]));
    expect(result.missingEntryIds).toEqual([gone.id]);
    expect(result.installed.map((m) => m.name)).toEqual(["llama3.2:latest", "phi4", "hermes3:8b", "qwen3:8b", "mistral-nemo:12b"]);
    expect(result.installed.find((m) => m.name === "llama3.2:latest")!.entryIds).toEqual([bare.id]);
    expect(result.installed.find((m) => m.name === "phi4")!.entryIds).toEqual([latest.id]);
    expect(result.installed.find((m) => m.name === "mistral-nemo:12b")).toMatchObject({ entryIds: [], sizeGb: 5, quantization: "Q4_K_M" });

    const byId = new Map((await svc.list(c)).map((e) => [e.id, e.availability]));
    expect(byId.get(bare.id)).toBe("installed");
    expect(byId.get(latest.id)).toBe("installed");
    expect(byId.get(gone.id)).toBe("planned");
    expect(byId.get(stillDownloading.id)).toBe("downloading");
    expect(byId.get(doneDownloading.id)).toBe("installed");
    expect(byId.get(already.id)).toBe("installed");
    expect(byId.get(elsewhere.id)).toBe("installed");
    expect((await svc.get(other, otherCompany.id)).availability).toBe("installed");
  });

  it("refuses an address the company does not use, and never calls it", async () => {
    const c = await newCompany("CVI");
    const other = await newCompany("CVJ");
    await svc.create(other, create({ name: "Theirs", provider: "local", model: "x", baseUrl: "http://100.7.7.7:11434/v1" }), actor);
    await svc.create(c, create({ name: "Cloud", provider: "openrouter", model: "a/b" }), actor);
    fetchStub.mockReset();
    // Another company's address, and a random host.
    await expect(svc.syncLocalModels(c, "http://100.7.7.7:11434/v1")).rejects.toMatchObject({ status: 422 });
    await expect(svc.syncLocalModels(c, "http://169.254.169.254/latest")).rejects.toMatchObject({ status: 422 });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("accepts a quick agent's local address, and reports every failure with one plain message", async () => {
    const c = await newCompany("CVK");
    await db.insert(agents).values({
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      companyId: c,
      laneAEnabled: true,
      name: "Secretary",
      laneAProvider: "local",
      laneAModel: "qwen3:14b",
      laneABaseUrl: "http://100.5.5.5:11434/v1",
    });
    fetchStub.mockReset();
    fetchStub.mockResolvedValue(tags(["qwen3:14b"]));
    const result = await svc.syncLocalModels(c, "http://100.5.5.5:11434");
    expect(fetchStub.mock.calls[0]![0]).toBe("http://100.5.5.5:11434/api/tags");
    expect(result).toMatchObject({ baseUrl: "http://100.5.5.5:11434/v1", markedInstalledEntryIds: [], missingEntryIds: [] });
    expect(result.installed[0]).toMatchObject({ name: "qwen3:14b", entryIds: [] });

    // Unreachable, an error status, a redirect refused by fetch, or not Ollama: the same message, no detail.
    const plain = { status: 422, message: localSyncFailedMessage("http://100.5.5.5:11434/v1") };
    expect(plain.message).toBe("Could not read the installed models from http://100.5.5.5:11434/v1. Check that the computer is on and the model server is running.");
    for (const failure of [
      () => fetchStub.mockRejectedValue(new Error("connect ETIMEDOUT")),
      () => fetchStub.mockRejectedValue(new TypeError("fetch failed: unexpected redirect")),
      () => fetchStub.mockResolvedValue(new Response("nope", { status: 500 })),
      () => fetchStub.mockResolvedValue(new Response("<html>", { status: 200 })),
    ]) {
      fetchStub.mockReset();
      failure();
      await expect(svc.syncLocalModels(c, "http://100.5.5.5:11434/v1")).rejects.toMatchObject(plain);
    }
  });
});

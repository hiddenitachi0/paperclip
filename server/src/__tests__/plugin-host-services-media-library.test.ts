import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CapabilityDeniedError, createHostClientHandlers, InvocationScopeDeniedError } from "@paperclipai/plugin-sdk";
import { companies, createDb, mediaModelSetups } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { mediaSetupsService } from "../services/media-setups.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping plugin host services media library tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

// Film studio Phase 1: ctx.mediaLibrary, the plugin worker's read-only view of
// the company's model setups, LoRA library and project defaults -- rows of
// the requested company only, the agent view on request, and refused for a
// plugin without media.library.read.
describeEmbeddedPostgres("plugin-host-services mediaLibrary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyA = "";
  let companyB = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-host-services-media-library-");
    db = createDb(tempDb.connectionString);
    companyA = randomUUID();
    companyB = randomUUID();
    for (const [id, prefix] of [
      [companyA, "MLA"],
      [companyB, "MLB"],
    ] as const) {
      await db.insert(companies).values({ id, name: `Media library ${prefix}`, issuePrefix: prefix });
    }
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function services() {
    return buildHostServices(db, "plugin-record-id", "paperclip.media-studio", createEventBusStub());
  }

  it("lists the company's own setups (seeding the starters once), with the agent view on request", async () => {
    const lib = services().mediaLibrary;
    const all = await lib.listSetups({ companyId: companyA });
    expect(all.map((s) => s.name).sort()).toEqual(["Action", "Natural", "Natural face & speech", "Romantic / calm", "Stills (Krea 2)"]);
    expect(all.every((s) => s.companyId === companyA)).toBe(true);
    expect((await lib.listSetups({ companyId: companyA, kind: "image" })).map((s) => s.name)).toEqual(["Stills (Krea 2)"]);
    expect(await lib.listSetups({ companyId: companyA, approvedOnly: true })).toEqual([]);

    const romantic = all.find((s) => s.name === "Romantic / calm")!;
    await mediaSetupsService(db).updateSetup(companyA, romantic.id, { status: "approved" }, { actorType: "user", actorId: "owner", agentId: null });
    expect((await lib.listSetups({ companyId: companyA, approvedOnly: true })).map((s) => s.name)).toEqual(["Romantic / calm"]);

    const loras = await lib.listLoras({ companyId: companyA });
    expect(loras.map((l) => l.ref).sort()).toEqual(["h3-better-motion", "h3-natural-face-speech"]);
    const defaults = await lib.getProjectDefaults({ companyId: companyA });
    expect(defaults).toMatchObject({ companyId: companyA, defaultContentRating: "sfw", defaultContinuityMode: "stills" });
    expect(defaults.defaultVideoSetupId).toBe(all.find((s) => s.name === "Natural")!.id);
  });

  it("resolves a setup to what a run sends, and never returns another company's rows", async () => {
    const lib = services().mediaLibrary;
    const setupsA = await lib.listSetups({ companyId: companyA });
    const setupsB = await lib.listSetups({ companyId: companyB });
    const actionA = setupsA.find((s) => s.name === "Action")!;
    const actionB = setupsB.find((s) => s.name === "Action")!;

    const resolved = await lib.resolve({ companyId: companyA, setupId: actionA.id });
    expect(resolved).toMatchObject({
      provider: "sogni",
      modelId: "minimax-h3-fl2va-fp8_flf2v",
      status: "draft",
      usable: true,
      params: { promptExpansion: false },
      loras: [{ ref: "h3-better-motion", source: "catalog", strength: 0.8 }],
    });
    // A draft is not there for an agent path.
    expect(await lib.resolve({ companyId: companyA, setupId: actionA.id, approvedOnly: true })).toBeNull();
    expect(await lib.getSetup({ companyId: companyA, setupId: actionA.id, approvedOnly: true })).toBeNull();

    // Company B's ids asked for as company A: nothing.
    expect(await lib.getSetup({ companyId: companyA, setupId: actionB.id })).toBeNull();
    expect(await lib.resolve({ companyId: companyA, setupId: actionB.id })).toBeNull();
    expect(await lib.getSetup({ companyId: companyA, setupId: "not-a-uuid" })).toBeNull();
    const loraIdsB = new Set((await lib.listLoras({ companyId: companyB })).map((l) => l.id));
    expect((await lib.listLoras({ companyId: companyA })).some((l) => loraIdsB.has(l.id))).toBe(false);
    await expect(lib.listSetups({ companyId: "" })).rejects.toThrow(/companyId is required/);

    const [rowB] = await db.select().from(mediaModelSetups).where(eq(mediaModelSetups.id, actionB.id));
    expect(rowB!.companyId).toBe(companyB);
  });

  it("refuses a plugin without media.library.read, and a UI action for another company", async () => {
    const svc = services();
    const without = createHostClientHandlers({ pluginId: "paperclip.other", capabilities: ["http.outbound"], services: svc });
    await expect(without["mediaLibrary.listSetups"]({ companyId: companyA })).rejects.toBeInstanceOf(CapabilityDeniedError);
    await expect(without["mediaLibrary.resolve"]({ companyId: companyA, setupId: randomUUID() })).rejects.toBeInstanceOf(CapabilityDeniedError);

    const withCap = createHostClientHandlers({ pluginId: "paperclip.media-studio", capabilities: ["media.library.read"], services: svc });
    const listed = await withCap["mediaLibrary.listSetups"]({ companyId: companyA }, { invocationScope: { companyId: companyA } });
    expect(listed.length).toBeGreaterThan(0);
    await expect(
      withCap["mediaLibrary.listSetups"]({ companyId: companyB }, { invocationScope: { companyId: companyA } }),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
  });
});

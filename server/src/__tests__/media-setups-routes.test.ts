import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  companies,
  createDb,
  mediaLoras,
  mediaModelSetups,
  mediaProjectDefaults,
  plugins,
  videoStorylines,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const { errorHandler } = await import("../middleware/index.js");
const { mediaSetupRoutes } = await import("../routes/media-setups.js");
const { mediaSetupsService } = await import("../services/media-setups.js");
const { videoStorylineService } = await import("../services/video-storylines.js");
const { videoStorylineSettingsService } = await import("../services/video-storyline-settings.js");

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping media setup register route tests: ${support.reason ?? "unsupported environment"}`);
}

type Who =
  | { board: string[]; role?: string; userId?: string }
  | { agentId: string; companyId: string };

// Media Studio film studio, Phase 1: the LoRA library, model setups and the
// register over real HTTP and a real Postgres -- who may do what (owner/admin
// write, members read, agents read approved setups only), company isolation,
// the capability checks, the D4 starters seeded once, and the storyline sync
// rule.
d("media setup register routes", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-media-setups-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    const manifest = {
      id: "paperclip.media-studio",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Media Studio",
      description: "Media generation",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "dist/worker.js" },
    } as unknown as PaperclipPluginManifestV1;
    await db.insert(plugins).values({
      pluginKey: "paperclip.media-studio",
      packageName: "@paperclipai/plugin-media-studio",
      version: "1.0.0",
      manifestJson: manifest,
      status: "ready",
    });
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
  });

  function appFor(who: Who) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor =
        "agentId" in who
          ? { type: "agent", source: "agent_jwt", agentId: who.agentId, companyId: who.companyId }
          : {
              type: "board",
              source: "session",
              userId: who.userId ?? randomUUID(),
              companyIds: who.board,
              isInstanceAdmin: false,
              memberships: who.board.map((companyId) => ({ companyId, status: "active", membershipRole: who.role ?? "owner" })),
            };
      next();
    });
    app.use("/api", mediaSetupRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Media ${companyId.slice(0, 6)}`,
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  /** A real agent row, for agent writes that land in the activity log. */
  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function listSetups(app: express.Express, companyId: string, query = "") {
    const res = await request(app).get(`/api/companies/${companyId}/media/setups${query}`);
    expect(res.status).toBe(200);
    return res.body as { setups: Array<Record<string, any>>; canEdit: boolean };
  }

  async function setupByName(app: express.Express, companyId: string, name: string) {
    const { setups } = await listSetups(app, companyId);
    const found = setups.find((s) => s.name === name);
    expect(found, name).toBeTruthy();
    return found!;
  }

  async function loraByRef(app: express.Express, companyId: string, ref: string) {
    const res = await request(app).get(`/api/companies/${companyId}/media/loras`);
    expect(res.status).toBe(200);
    const found = (res.body.loras as Array<Record<string, any>>).find((l) => l.ref === ref);
    expect(found, ref).toBeTruthy();
    return found!;
  }

  describe("starters", () => {
    it("seeds the D4 starters once per company, even when two first requests race", async () => {
      const companyId = await seedCompany();
      const app = appFor({ board: [companyId] });
      await Promise.all([listSetups(app, companyId), listSetups(app, companyId), request(app).get(`/api/companies/${companyId}/media/loras`)]);
      const { setups, canEdit } = await listSetups(app, companyId);
      expect(canEdit).toBe(true);
      expect(setups.map((s) => s.name).sort()).toEqual(["Action", "Natural", "Natural face & speech", "Romantic / calm", "Stills (Krea 2)"]);
      expect(setups.every((s) => s.status === "draft" && s.contentRating === "sfw" && s.problems.length === 0)).toBe(true);

      const action = setups.find((s) => s.name === "Action")!;
      expect(action).toMatchObject({ provider: "sogni", modelId: "minimax-h3-fl2va-fp8_flf2v", mode: "flf2v", billing: "sogni-unlimited" });
      expect(action.loras).toEqual([expect.objectContaining({ ref: "h3-better-motion", strength: 0.8, contentTag: "sfw" })]);
      expect(setups.find((s) => s.name === "Natural")!.loras[0]).toMatchObject({ ref: "h3-better-motion", strength: 0.6 });
      expect(setups.find((s) => s.name === "Natural face & speech")!.loras[0]).toMatchObject({ ref: "h3-natural-face-speech", strength: 0.6 });
      const romantic = setups.find((s) => s.name === "Romantic / calm")!;
      expect(romantic).toMatchObject({ modelId: "wan3.0-video", loras: [], billing: "sogni-premium" });

      const rows = await db.select().from(mediaModelSetups).where(eq(mediaModelSetups.companyId, companyId));
      expect(rows).toHaveLength(5);
      expect(await db.select().from(mediaLoras).where(eq(mediaLoras.companyId, companyId))).toHaveLength(2);

      const defaults = await request(app).get(`/api/companies/${companyId}/media/project-defaults`);
      expect(defaults.body).toMatchObject({ defaultContentRating: "sfw", defaultContinuityMode: "stills" });
      expect(defaults.body.defaultVideoSetupId).toBe(setups.find((s) => s.name === "Natural")!.id);
      expect(defaults.body.defaultImageSetupId).toBe(setups.find((s) => s.name === "Stills (Krea 2)")!.id);
      expect(defaults.body.setupsSeededAt).toBeTruthy();
    });

    it("does not bring a deleted starter back", async () => {
      const companyId = await seedCompany();
      const app = appFor({ board: [companyId] });
      const action = await setupByName(app, companyId, "Action");
      expect((await request(app).delete(`/api/companies/${companyId}/media/setups/${action.id}`)).status).toBe(204);
      const { setups } = await listSetups(app, companyId);
      expect(setups.map((s) => s.name)).not.toContain("Action");
      await mediaSetupsService(db).ensureStarters(companyId);
      expect(await db.select().from(mediaModelSetups).where(eq(mediaModelSetups.companyId, companyId))).toHaveLength(4);
    });
  });

  describe("checking setups", () => {
    it("creates a valid H3 setup and refuses invalid model/LoRA combinations with a reason", async () => {
      const companyId = await seedCompany();
      const app = appFor({ board: [companyId] });
      const betterMotion = await loraByRef(app, companyId, "h3-better-motion");

      const created = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({
          kind: "video",
          name: "Calm walk",
          provider: "sogni",
          modelId: "minimax-h3-fl2va-fp8_i2v",
          loras: [{ loraId: betterMotion.id, strength: 0.45 }],
          params: { promptExpansion: false },
        });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: "Calm walk", mode: "i2v", status: "draft", contentRating: "sfw" });

      const wan = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "Wan with LoRA", provider: "sogni", modelId: "wan3.0-video", loras: [{ loraId: betterMotion.id, strength: 0.6 }], params: { promptExpansion: false } });
      expect(wan.status).toBe(422);
      expect(wan.body.error).toMatch(/Wan 3 takes no LoRA/);

      const percent = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "Too strong", provider: "sogni", modelId: "minimax-h3-fl2va-fp8_flf2v", loras: [{ loraId: betterMotion.id, strength: 35 }], params: { promptExpansion: false } });
      expect(percent.status).toBe(422);
      expect(percent.body.error).toMatch(/multipliers, not percentages/);

      const noStrength = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "No strength", provider: "sogni", modelId: "minimax-h3-fl2va-fp8_flf2v", loras: [{ loraId: betterMotion.id }], params: { promptExpansion: false } });
      expect(noStrength.status).toBe(400);

      const higgsVideo = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "Higgs video", provider: "higgsfield", modelId: "soul", params: { promptExpansion: false } });
      expect(higgsVideo.status).toBe(422);
      expect(higgsVideo.body.error).toMatch(/only use Fal or Sogni/);

      const duplicate = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "calm WALK", provider: "sogni", modelId: "wan3.0-video", params: { promptExpansion: false } });
      expect(duplicate.status).toBe(409);

      const check = await request(app)
        .post(`/api/companies/${companyId}/media/setups/check`)
        .send({ kind: "video", name: "x", provider: "fal", modelId: "fal-ai/wan-flf2v", params: { promptExpansion: false } });
      expect(check.status).toBe(200);
      expect(check.body).toMatchObject({ ok: true, family: "wan21", mode: "flf2v", billing: "fal-pay-per-use" });
    });

    it("raises the rating to mature for an unreviewed LoRA, and refuses approving a setup that has a refused LoRA", async () => {
      const companyId = await seedCompany();
      const app = appFor({ board: [companyId] });
      const lora = await request(app)
        .post(`/api/companies/${companyId}/media/loras`)
        .send({ provider: "sogni", source: "catalog", ref: "h3-realism-people", name: "Realism People", family: "h3", strengthMin: 0, strengthMax: 2 });
      expect(lora.status).toBe(201);
      expect(lora.body).toMatchObject({ contentTag: "unreviewed", effectiveContentTag: "unreviewed", strengthDefault: 0.6 });

      const setup = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "Realism", provider: "sogni", modelId: "minimax-h3-fl2va-fp8_flf2v", loras: [{ loraId: lora.body.id, strength: 0.7 }], params: { promptExpansion: false } });
      expect(setup.status).toBe(201);
      expect(setup.body.contentRating).toBe("mature");
      expect(setup.body.matureReasons.join(" ")).toMatch(/not been reviewed/);

      // Reviewed as safe for work: the rating follows at once.
      const reviewed = await request(app).patch(`/api/companies/${companyId}/media/loras/${lora.body.id}`).send({ contentTag: "sfw" });
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.reviewedByUserId).toBeTruthy();
      expect((await request(app).get(`/api/companies/${companyId}/media/setups/${setup.body.id}`)).body.contentRating).toBe("sfw");

      // Refused later: the setup shows the problem and cannot be approved.
      await request(app).patch(`/api/companies/${companyId}/media/loras/${lora.body.id}`).send({ contentTag: "refused" });
      const view = await request(app).get(`/api/companies/${companyId}/media/setups/${setup.body.id}`);
      expect(view.body.problems.join(" ")).toMatch(/refused/);
      const approve = await request(app).patch(`/api/companies/${companyId}/media/setups/${setup.body.id}`).send({ status: "approved" });
      expect(approve.status).toBe(422);
      // Renaming still works.
      expect((await request(app).patch(`/api/companies/${companyId}/media/setups/${setup.body.id}`).send({ name: "Realism (old)" })).status).toBe(200);
    });
  });

  describe("setup params", () => {
    it("refuses a param that would switch a provider's safety filter, and never passes a stored one on", async () => {
      const companyId = await seedCompany();
      const app = appFor({ board: [companyId] });
      const unsafe = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({
          kind: "video",
          name: "Unsafe",
          provider: "fal",
          modelId: "fal-ai/wan-flf2v",
          params: { promptExpansion: false, enable_safety_checker: false, safety_tolerance: "6" },
        });
      expect(unsafe.status).toBe(400);
      expect(JSON.stringify(unsafe.body.details)).toMatch(/would change the service's safety filter/);

      const stills = await setupByName(app, companyId, "Stills (Krea 2)");
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/media/setups/${stills.id}`)
        .send({ params: { promptExpansion: false, disableNSFWFilter: true } });
      expect(patched.status).toBe(400);
      const check = await request(app)
        .post(`/api/companies/${companyId}/media/setups/check`)
        .send({ kind: "image", name: "x", provider: "sogni", modelId: "krea2_turbo_fp8_scaled", params: { promptExpansion: false, nsfw: true } });
      expect(check.status).toBe(400);

      // A row written outside the API: shown as a problem, not usable, and the switch never reaches a run.
      await db
        .update(mediaModelSetups)
        .set({ params: { promptExpansion: false, disableNSFWFilter: true, seed: 7 }, status: "approved" })
        .where(eq(mediaModelSetups.id, stills.id));
      const agent = appFor({ agentId: randomUUID(), companyId });
      const resolved = await request(agent).get(`/api/companies/${companyId}/media/setups/${stills.id}/resolve`);
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ usable: false, contentRating: "sfw" });
      expect(resolved.body.params).toEqual({ promptExpansion: false, seed: 7 });
      expect(resolved.body.problems.join(" ")).toMatch(/"disableNSFWFilter" would change the service's safety filter/);
      const view = await request(app).get(`/api/companies/${companyId}/media/setups/${stills.id}`);
      expect(view.body.params).toEqual({ promptExpansion: false, seed: 7 });
    });
  });

  describe("LoRA library", () => {
    it("saves Fal links, never saves a filter-bypass LoRA, and will not delete a LoRA a setup uses", async () => {
      const companyId = await seedCompany();
      const app = appFor({ board: [companyId] });
      const link = await request(app)
        .post(`/api/companies/${companyId}/media/loras`)
        .send({ provider: "fal", source: "url", ref: "https://huggingface.co/acme/motion/resolve/main/motion.safetensors", name: "Acme motion", family: "wan21", triggerWords: ["acme-move"], contentTag: "sfw" });
      expect(link.status).toBe(201);
      expect(link.body).toMatchObject({ provider: "fal", effectiveContentTag: "sfw", triggerWords: ["acme-move"] });

      const bypass = await request(app)
        .post(`/api/companies/${companyId}/media/loras`)
        .send({ provider: "sogni", source: "catalog", ref: "krea2-filter-bypass-2", name: "Filter Bypass 2" });
      expect(bypass.status).toBe(422);
      expect(bypass.body.error).toMatch(/never be saved/);

      const flaggedSfw = await request(app)
        .post(`/api/companies/${companyId}/media/loras`)
        .send({ provider: "sogni", source: "catalog", ref: "krea2-breast", name: "Breast", contentTag: "sfw" });
      expect(flaggedSfw.status).toBe(422);

      const again = await request(app)
        .post(`/api/companies/${companyId}/media/loras`)
        .send({ provider: "sogni", source: "catalog", ref: "h3-better-motion", name: "Better Motion copy" });
      expect(again.status).toBe(409);

      const setup = await request(app)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "Fal Wan 2.1", provider: "fal", modelId: "fal-ai/wan-flf2v", loras: [{ loraId: link.body.id, strength: 1 }], params: { promptExpansion: false } });
      expect(setup.status).toBe(201);
      expect(setup.body.triggerWords).toEqual(["acme-move"]);

      const del = await request(app).delete(`/api/companies/${companyId}/media/loras/${link.body.id}`);
      expect(del.status).toBe(409);
      expect(del.body.error).toMatch(/Fal Wan 2.1/);
      const archived = await request(app).patch(`/api/companies/${companyId}/media/loras/${link.body.id}`).send({ archived: true });
      expect(archived.body.archivedAt).toBeTruthy();
      const list = await request(app).get(`/api/companies/${companyId}/media/loras`);
      expect((list.body.loras as Array<{ id: string }>).map((l) => l.id)).not.toContain(link.body.id);
    });
  });

  describe("who may do what", () => {
    it("lets members read but not write", async () => {
      const companyId = await seedCompany();
      const member = appFor({ board: [companyId], role: "member" });
      const { setups, canEdit } = await listSetups(member, companyId);
      expect(canEdit).toBe(false);
      expect(setups).toHaveLength(5);
      const create = await request(member)
        .post(`/api/companies/${companyId}/media/setups`)
        .send({ kind: "video", name: "Nope", provider: "sogni", modelId: "wan3.0-video", params: { promptExpansion: false } });
      expect(create.status).toBe(403);
      expect((await request(member).patch(`/api/companies/${companyId}/media/setups/${setups[0]!.id}`).send({ notes: "x" })).status).toBe(403);
      expect((await request(member).patch(`/api/companies/${companyId}/media/project-defaults`).send({ defaultContinuityMode: "keyframes" })).status).toBe(403);
    });

    it("shows agents approved setups only and never lets them write", async () => {
      const companyId = await seedCompany();
      const owner = appFor({ board: [companyId] });
      const agent = appFor({ agentId: randomUUID(), companyId });
      const romantic = await setupByName(owner, companyId, "Romantic / calm");
      const natural = await setupByName(owner, companyId, "Natural");

      expect((await listSetups(agent, companyId)).setups).toEqual([]);
      expect((await request(agent).get(`/api/companies/${companyId}/media/setups/${natural.id}`)).status).toBe(404);
      expect((await request(agent).get(`/api/companies/${companyId}/media/setups/${natural.id}/resolve`)).status).toBe(404);

      const approved = await request(owner).patch(`/api/companies/${companyId}/media/setups/${romantic.id}`).send({ status: "approved" });
      expect(approved.status).toBe(200);
      expect(approved.body.approvedByUserId).toBeTruthy();

      const seen = await listSetups(agent, companyId);
      expect(seen.canEdit).toBe(false);
      expect(seen.setups.map((s) => s.name)).toEqual(["Romantic / calm"]);
      const resolved = await request(agent).get(`/api/companies/${companyId}/media/setups/${romantic.id}/resolve`);
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ provider: "sogni", modelId: "wan3.0-video", usable: true, loras: [], params: { promptExpansion: false } });

      const writes = [
        request(agent).post(`/api/companies/${companyId}/media/setups`).send({ kind: "video", name: "Agent", provider: "sogni", modelId: "wan3.0-video", params: { promptExpansion: false } }),
        request(agent).patch(`/api/companies/${companyId}/media/setups/${romantic.id}`).send({ notes: "mine" }),
        request(agent).delete(`/api/companies/${companyId}/media/setups/${romantic.id}`),
        request(agent).post(`/api/companies/${companyId}/media/loras`).send({ provider: "sogni", source: "catalog", ref: "h3-combat-base-v2", name: "Combat" }),
        request(agent).post(`/api/companies/${companyId}/media/setups/${romantic.id}/trials`).send({ scores: { naturalness: 5 } }),
        request(agent).patch(`/api/companies/${companyId}/media/project-defaults`).send({ defaultContinuityMode: "keyframes" }),
      ];
      for (const res of await Promise.all(writes)) expect(res.status).toBe(403);
      const [row] = await db.select().from(mediaModelSetups).where(eq(mediaModelSetups.id, romantic.id));
      expect(row!.notes).not.toBe("mine");
    });

    it("keeps companies apart", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const ownerA = appFor({ board: [companyA] });
      const ownerB = appFor({ board: [companyB] });
      const setupB = await setupByName(ownerB, companyB, "Natural");
      const loraB = await loraByRef(ownerB, companyB, "h3-better-motion");

      // Another company's id through your own company's path: not found.
      expect((await request(ownerA).get(`/api/companies/${companyA}/media/setups/${setupB.id}`)).status).toBe(404);
      expect((await request(ownerA).get(`/api/companies/${companyA}/media/setups/${setupB.id}/resolve`)).status).toBe(404);
      expect((await request(ownerA).patch(`/api/companies/${companyA}/media/setups/${setupB.id}`).send({ notes: "x" })).status).toBe(404);
      expect((await request(ownerA).delete(`/api/companies/${companyA}/media/loras/${loraB.id}`)).status).toBe(404);
      // Another company's LoRA in your own setup: refused.
      const borrowed = await request(ownerA)
        .post(`/api/companies/${companyA}/media/setups`)
        .send({ kind: "video", name: "Borrowed", provider: "sogni", modelId: "minimax-h3-fl2va-fp8_flf2v", loras: [{ loraId: loraB.id, strength: 0.6 }], params: { promptExpansion: false } });
      expect(borrowed.status).toBe(422);
      expect(borrowed.body.error).toMatch(/not in this company's LoRA library/);
      // Another company's setup as your default: refused.
      expect((await request(ownerA).patch(`/api/companies/${companyA}/media/project-defaults`).send({ defaultVideoSetupId: setupB.id })).status).toBe(422);
      // Another company's path: forbidden, for people and agents.
      expect((await request(ownerA).get(`/api/companies/${companyB}/media/setups`)).status).toBe(403);
      expect((await request(appFor({ agentId: randomUUID(), companyId: companyA })).get(`/api/companies/${companyB}/media/setups`)).status).toBe(403);
      // Nothing of B leaks into A's list.
      const { setups } = await listSetups(ownerA, companyA);
      expect(setups.every((s) => s.companyId === companyA)).toBe(true);
    });

    it("lets only the owner make mature the default content rating", async () => {
      const companyId = await seedCompany();
      const admin = appFor({ board: [companyId], role: "admin" });
      const owner = appFor({ board: [companyId], role: "owner" });
      expect((await request(admin).patch(`/api/companies/${companyId}/media/project-defaults`).send({ defaultContentRating: "mature" })).status).toBe(403);
      expect((await request(admin).patch(`/api/companies/${companyId}/media/project-defaults`).send({ defaultContinuityMode: "keyframes" })).status).toBe(200);
      const res = await request(owner).patch(`/api/companies/${companyId}/media/project-defaults`).send({ defaultContentRating: "mature" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ defaultContentRating: "mature", defaultContinuityMode: "keyframes" });
      const [log] = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "media.project_defaults_updated")));
      expect(log).toBeTruthy();
    });
  });

  describe("register", () => {
    it("records tries with 1-5 scores and shows the summary on the setup", async () => {
      const companyId = await seedCompany();
      const otherCompany = await seedCompany();
      const app = appFor({ board: [companyId] });
      const natural = await setupByName(app, companyId, "Natural");
      const first = await request(app)
        .post(`/api/companies/${companyId}/media/setups/${natural.id}/trials`)
        .send({ scores: { naturalness: 4, movement: 5, faceContinuity: 3 }, costCents: 30, secondsTaken: 120 });
      expect(first.status).toBe(201);
      await request(app)
        .post(`/api/companies/${companyId}/media/setups/${natural.id}/trials`)
        .send({ scores: { naturalness: 2 }, flaggedByCheck: true, costCents: 50 });
      expect((await request(app).post(`/api/companies/${companyId}/media/setups/${natural.id}/trials`).send({ scores: { naturalness: 9 } })).status).toBe(400);

      const [otherStoryline] = await db.insert(videoStorylines).values({ companyId: otherCompany, title: "Theirs" }).returning();
      const foreign = await request(app)
        .post(`/api/companies/${companyId}/media/setups/${natural.id}/trials`)
        .send({ scores: { naturalness: 3 }, storylineId: otherStoryline!.id });
      expect(foreign.status).toBe(422);

      const view = await request(app).get(`/api/companies/${companyId}/media/setups/${natural.id}`);
      expect(view.body.register).toMatchObject({
        trialCount: 2,
        flaggedCount: 1,
        sfwTendency: "leans_mature",
        averageCostCents: 40,
        averageSeconds: 120,
      });
      expect(view.body.register.humanScores).toMatchObject({ naturalness: 3, movement: 5, faceContinuity: 3, outfitStability: null });

      const trials = await request(app).get(`/api/companies/${companyId}/media/setups/${natural.id}/trials`);
      expect(trials.body.trials).toHaveLength(2);
      expect((await request(app).delete(`/api/companies/${companyId}/media/setups/${natural.id}/trials/${first.body.id}`)).status).toBe(204);
      expect((await request(app).get(`/api/companies/${companyId}/media/setups/${natural.id}/trials`)).body.trials).toHaveLength(1);
    });
  });

  describe("storylines: one source of truth for the model", () => {
    it("copies the setup's provider and model, and a direct model edit clears the pick", async () => {
      const companyId = await seedCompany();
      await videoStorylineSettingsService(db).setEnabled(companyId, true);
      const owner = appFor({ board: [companyId] });
      const natural = await setupByName(owner, companyId, "Natural");
      const stills = await setupByName(owner, companyId, "Stills (Krea 2)");
      const [storyline] = await db
        .insert(videoStorylines)
        .values({ companyId, title: "Cafe", providerId: "fal", pictureSettings: { lookId: "look-1" } })
        .returning();

      const picked = await request(owner)
        .put(`/api/companies/${companyId}/media/storylines/${storyline!.id}/setups`)
        .send({ videoSetupId: natural.id, imageSetupId: stills.id });
      expect(picked.status).toBe(200);
      expect(picked.body).toMatchObject({
        providerId: "sogni",
        model: "minimax-h3-fl2va-fp8_flf2v",
        videoSetupId: natural.id,
        imageSetupId: stills.id,
        pictureSettings: { providerId: "sogni", model: "krea2_turbo_fp8_scaled", lookId: "look-1" },
      });

      const wrongKind = await request(owner).put(`/api/companies/${companyId}/media/storylines/${storyline!.id}/setups`).send({ videoSetupId: stills.id });
      expect(wrongKind.status).toBe(422);

      // An agent may pick approved setups only.
      const agent = appFor({ agentId: await seedAgent(companyId), companyId });
      const draftPick = await request(agent).put(`/api/companies/${companyId}/media/storylines/${storyline!.id}/setups`).send({ videoSetupId: natural.id });
      expect(draftPick.status).toBe(422);
      await request(owner).patch(`/api/companies/${companyId}/media/setups/${natural.id}`).send({ status: "approved" });
      expect((await request(agent).put(`/api/companies/${companyId}/media/storylines/${storyline!.id}/setups`).send({ videoSetupId: natural.id })).status).toBe(200);

      const storylines = videoStorylineService(db);
      const actor = { actorType: "user" as const, actorId: "board", agentId: null };
      // The same values sent back (e.g. while changing the look) keep the picks.
      const same = await storylines.updateStoryline(
        companyId,
        storyline!.id,
        { providerId: "sogni", model: "minimax-h3-fl2va-fp8_flf2v", pictureSettings: { providerId: "sogni", model: "krea2_turbo_fp8_scaled", lookId: "look-2" } },
        actor,
      );
      expect(same).toMatchObject({ videoSetupId: natural.id, imageSetupId: stills.id });
      // A different model is "custom (not from a setup)".
      const custom = await storylines.updateStoryline(companyId, storyline!.id, { model: "minimax-h3-fl2va-fp8_flf2v_turbo" }, actor);
      expect(custom).toMatchObject({ videoSetupId: null, imageSetupId: stills.id, model: "minimax-h3-fl2va-fp8_flf2v_turbo" });
      const customPicture = await storylines.updateStoryline(companyId, storyline!.id, { pictureSettings: { providerId: "fal", model: null, lookId: null } }, actor);
      expect(customPicture.imageSetupId).toBeNull();

      // Deleting a setup leaves the storyline on its last copied model.
      await db.update(videoStorylines).set({ videoSetupId: natural.id }).where(eq(videoStorylines.id, storyline!.id));
      await request(owner).delete(`/api/companies/${companyId}/media/setups/${natural.id}`);
      const [after] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, storyline!.id));
      expect(after).toMatchObject({ videoSetupId: null, providerId: "sogni" });
      const [defaults] = await db.select().from(mediaProjectDefaults).where(eq(mediaProjectDefaults.companyId, companyId));
      expect(defaults!.defaultVideoSetupId).toBeNull();
    });

    it("carries a changed setup's provider and model to the storylines that use it, and unlinks the ones it cannot", async () => {
      const companyId = await seedCompany();
      await videoStorylineSettingsService(db).setEnabled(companyId, true);
      const owner = appFor({ board: [companyId] });
      const natural = await setupByName(owner, companyId, "Natural");
      const stills = await setupByName(owner, companyId, "Stills (Krea 2)");
      const [draft] = await db.insert(videoStorylines).values({ companyId, title: "Draft", providerId: "fal", pictureSettings: { lookId: "look-1" } }).returning();
      const [busy] = await db.insert(videoStorylines).values({ companyId, title: "Busy", providerId: "fal" }).returning();
      for (const storyline of [draft!, busy!]) {
        const picked = await request(owner)
          .put(`/api/companies/${companyId}/media/storylines/${storyline.id}/setups`)
          .send({ videoSetupId: natural.id, imageSetupId: stills.id });
        expect(picked.status).toBe(200);
      }
      // The second one starts rendering; the first carries an estimate the sync must refresh.
      await db.update(videoStorylines).set({ status: "rendering" }).where(eq(videoStorylines.id, busy!.id));
      await db.update(videoStorylines).set({ estimatedTotalCents: 999 }).where(eq(videoStorylines.id, draft!.id));
      const read = async (id: string) => (await db.select().from(videoStorylines).where(eq(videoStorylines.id, id)))[0]!;
      const busyBefore = await read(busy!.id);

      // A note or a LoRA strength is not copied: the storylines stay as they are.
      expect((await request(owner).patch(`/api/companies/${companyId}/media/setups/${natural.id}`).send({ notes: "calm" })).status).toBe(200);
      expect((await read(draft!.id)).estimatedTotalCents).toBe(999);

      // Natural moves to Fal Wan 2.1: the draft follows (new estimate), the rendering one keeps its model and is unlinked.
      const moved = await request(owner)
        .patch(`/api/companies/${companyId}/media/setups/${natural.id}`)
        .send({ provider: "fal", modelId: "fal-ai/wan-flf2v", mode: null, loras: [] });
      expect(moved.status).toBe(200);
      expect(await read(draft!.id)).toMatchObject({ providerId: "fal", model: "fal-ai/wan-flf2v", videoSetupId: natural.id, imageSetupId: stills.id, estimatedTotalCents: 0 });
      const busyAfter = await read(busy!.id);
      expect(busyAfter).toMatchObject({ status: "rendering", providerId: "sogni", model: "minimax-h3-fl2va-fp8_flf2v", videoSetupId: null, imageSetupId: stills.id });
      // Its updated_at is the stall clock of a render: untouched.
      expect(busyAfter.updatedAt.getTime()).toBe(busyBefore.updatedAt.getTime());

      // Sending the same model again changes nothing. A copy that drifted from
      // the setup (what two edits of the setup at once could leave) is brought
      // back by the next edit that sends the model, compared with the stored setup.
      expect((await request(owner).patch(`/api/companies/${companyId}/media/setups/${natural.id}`).send({ modelId: "fal-ai/wan-flf2v" })).status).toBe(200);
      await db.update(videoStorylines).set({ model: "fal-ai/wan-i2v" }).where(eq(videoStorylines.id, draft!.id));
      const again = await request(owner).patch(`/api/companies/${companyId}/media/setups/${natural.id}`).send({ modelId: "fal-ai/wan-flf2v" });
      expect(again.status).toBe(200);
      expect(await read(draft!.id)).toMatchObject({ providerId: "fal", model: "fal-ai/wan-flf2v", videoSetupId: natural.id });

      // Stills moves to Higgsfield, which storyline pictures cannot use: unlinked, the copied picture model stays.
      const higgs = await request(owner).patch(`/api/companies/${companyId}/media/setups/${stills.id}`).send({ provider: "higgsfield", modelId: "soul", mode: null });
      expect(higgs.status).toBe(200);
      expect(await read(draft!.id)).toMatchObject({
        imageSetupId: null,
        pictureSettings: { providerId: "sogni", model: "krea2_turbo_fp8_scaled", lookId: "look-1" },
      });

      // Natural becomes a picture setup: it can no longer be the draft's video setup.
      const kind = await request(owner).patch(`/api/companies/${companyId}/media/setups/${natural.id}`).send({ kind: "image", modelId: "fal-ai/flux-lora", mode: null });
      expect(kind.status).toBe(200);
      expect(await read(draft!.id)).toMatchObject({ videoSetupId: null, providerId: "fal", model: "fal-ai/wan-flf2v" });

      const logs = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      const forStoryline = (id: string, action: string) => logs.filter((log) => log.entityId === id && log.action === action);
      // The move and the drift repair; the re-sent same model logged nothing.
      expect(forStoryline(draft!.id, "video_storyline.setup_followed")).toHaveLength(2);
      expect(forStoryline(draft!.id, "video_storyline.setup_unlinked")).toHaveLength(2);
      expect(forStoryline(busy!.id, "video_storyline.setup_unlinked")).toHaveLength(2);
      const movedLog = logs.find(
        (log) => log.entityId === natural.id && ((log.details as Record<string, unknown>)?.storylinesUnlinked as string[] | undefined)?.includes(busy!.id),
      );
      expect(movedLog?.details).toMatchObject({ storylinesFollowed: [draft!.id], storylinesUnlinked: [busy!.id] });
    });

    it("needs video storylines switched on and refuses another company's storyline", async () => {
      const companyId = await seedCompany();
      const other = await seedCompany();
      await videoStorylineSettingsService(db).setEnabled(other, true);
      const owner = appFor({ board: [companyId] });
      const natural = await setupByName(owner, companyId, "Natural");
      const [mine] = await db.insert(videoStorylines).values({ companyId, title: "Mine" }).returning();
      expect((await request(owner).put(`/api/companies/${companyId}/media/storylines/${mine!.id}/setups`).send({ videoSetupId: natural.id })).status).toBe(422);
      await videoStorylineSettingsService(db).setEnabled(companyId, true);
      const [theirs] = await db.insert(videoStorylines).values({ companyId: other, title: "Theirs" }).returning();
      expect((await request(owner).put(`/api/companies/${companyId}/media/storylines/${theirs!.id}/setups`).send({ videoSetupId: natural.id })).status).toBe(404);
      const [untouched] = await db.select().from(videoStorylines).where(eq(videoStorylines.id, theirs!.id));
      expect(untouched!.videoSetupId).toBeNull();
    });
  });
});

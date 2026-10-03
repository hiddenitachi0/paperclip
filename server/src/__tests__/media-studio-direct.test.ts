import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  MEDIA_STUDIO_DIRECT_AUDIO_COST_CENTS_PER_SECOND,
  MEDIA_STUDIO_DIRECT_BILLING_CODE,
  MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS,
  MEDIA_STUDIO_DIRECT_REWRITE_BILLING_CODE,
} from "@paperclipai/shared";
import { companies, costEvents, createDb, mediaStudioDirectCreations, plugins } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { mediaStudioDirectRoutes } from "../routes/media-studio-direct.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { secretService } from "../services/secrets.js";
import { clearFalPriceCache } from "../services/fal-cost.js";

/**
 * DUR-4329: Media Studio's Create tab direct generation -- a board
 * owner/admin/operator (never a viewer, never an agent) triggers the same
 * Fal provider actions agents already call, gated by an upfront cost
 * estimate and a company-budget + per-plugin-cap check, with the result
 * saved to company storage. Only the lowest-level outbound HTTP primitive
 * (safe-outbound-fetch.ts) is mocked -- the real FalDirectPictureProvider,
 * saveResultFile, and recordCreation code all run for real.
 */

vi.mock("../services/safe-outbound-fetch.js", () => ({
  validateAndResolveFetchUrl: vi.fn(async (urlString: string) => ({
    parsedUrl: new URL(urlString),
    resolvedAddress: "127.0.0.1",
    hostHeader: new URL(urlString).host,
    useTls: true,
  })),
  executePinnedHttpRequest: vi.fn(),
}));

const { mediaStudioDirectService } = await import("../services/media-studio-direct.js");
const { executePinnedHttpRequest } = await import("../services/safe-outbound-fetch.js");
const mockedExecute = vi.mocked(executePinnedHttpRequest);

function fakeFalResponse(body: Record<string, unknown>) {
  const json = Buffer.from(JSON.stringify(body));
  return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: json.toString("utf8"), bodyBytes: json };
}

/** Fal's async queue API (music/speech, video) returns a `url` rather than a data URL, so mediaResultBytes makes a second outbound fetch for the raw bytes -- this fakes that fetch's response. */
function fakeBinaryResponse(contentType: string, bytes: Buffer) {
  return { status: 200, statusText: "OK", headers: { "content-type": contentType }, body: bytes.toString("binary"), bodyBytes: bytes };
}

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping Media Studio direct-generation tests: ${support.reason ?? "unsupported environment"}`);
}

const MEDIA_STUDIO_PLUGIN_KEY = "paperclip.media-studio";

d("Media Studio Create tab direct generation (DUR-4329)", () => {
  let db!: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousBind = process.env.PAPERCLIP_BIND;
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur4329-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    // saveResultFile's getStorageService() calls loadConfig(), which infers
    // bind mode from $HOST -- an ambient non-loopback $HOST in this shell
    // (unrelated to this feature) would otherwise fail config validation
    // for the default "local_trusted" deployment mode.
    process.env.PAPERCLIP_BIND = "loopback";
    const started = await startEmbeddedPostgresTestDatabase("media-studio-direct");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);

    const manifest = {
      id: MEDIA_STUDIO_PLUGIN_KEY,
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
      pluginKey: MEDIA_STUDIO_PLUGIN_KEY,
      packageName: "@paperclipai/plugin-media-studio",
      version: "1.0.0",
      manifestJson: manifest,
      status: "ready",
    });
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
    rmSync(tmpDir, { recursive: true, force: true });
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousBind === undefined) delete process.env.PAPERCLIP_BIND;
    else process.env.PAPERCLIP_BIND = previousBind;
  });

  beforeEach(() => {
    mockedExecute.mockReset();
    clearFalPriceCache();
  });

  async function seedCompany(overrides: { budgetMonthlyCents?: number } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Direct Gen Co",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      budgetMonthlyCents: overrides.budgetMonthlyCents ?? 0,
    });
    return companyId;
  }

  async function setMediaStudioConfig(configJson: Record<string, unknown>) {
    const [plugin] = await db.select().from(plugins).where(eq(plugins.pluginKey, MEDIA_STUDIO_PLUGIN_KEY));
    await pluginRegistryService(db).upsertConfig(plugin!.id, { configJson });
  }

  /** A real local_encrypted company secret, the same path a Media Studio Fal key takes in production. */
  async function seedFalSecret(companyId: string, value = "fal-test-key") {
    const secret = await secretService(db).createManagedLocalSecret(
      companyId,
      { name: "Fal API key", key: "fal_api_key", value },
      { userId: "owner-user" },
    );
    await setMediaStudioConfig({ falKeySecretRef: secret.id });
    return secret.id;
  }

  describe("budget and cap gates (service, no provider call reached)", () => {
    it("refuses a picture when it would exceed the company's monthly budget", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal - 1 });
      await setMediaStudioConfig({});

      await expect(
        mediaStudioDirectService(db).createPicture(companyId, { userId: "owner-user", isCompanyAdmin: true }, { prompt: "a cat", provider: "fal" }),
      ).rejects.toMatchObject({ status: 422, details: { reason: "company_budget" } });
      expect(mockedExecute).not.toHaveBeenCalled();
    });

    it("refuses a picture when it would exceed the Media Studio direct-create plugin cap, even with company budget to spare", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      await setMediaStudioConfig({ directCreateMonthlyCapCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal - 1 });

      await expect(
        mediaStudioDirectService(db).createPicture(companyId, { userId: "owner-user", isCompanyAdmin: true }, { prompt: "a cat", provider: "fal" }),
      ).rejects.toMatchObject({ status: 422, details: { reason: "direct_create_cap" } });
      expect(mockedExecute).not.toHaveBeenCalled();
    });

    it("lets confirmBudgetCapCents override the plugin cap for a single call, for a company owner/admin", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId, directCreateMonthlyCapCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal - 1 });

      mockedExecute.mockResolvedValueOnce(
        fakeFalResponse({ images: [{ url: "data:image/jpeg;base64,Zm9vYmFy", content_type: "image/jpeg" }], seed: 7 }),
      );

      const result = await mediaStudioDirectService(db).createPicture(
        companyId,
        { userId: "owner-user", isCompanyAdmin: true },
        { prompt: "a cat", provider: "fal", confirmBudgetCapCents: 1_000 },
      );
      expect(result.costCents).toBe(MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal);
    });

    it("refuses confirmBudgetCapCents from a non-admin (operator) -- DUR-4335 security review fix", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId, directCreateMonthlyCapCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal - 1 });

      await expect(
        mediaStudioDirectService(db).createPicture(
          companyId,
          { userId: "operator-user", isCompanyAdmin: false },
          { prompt: "a cat", provider: "fal", confirmBudgetCapCents: 1_000_000 },
        ),
      ).rejects.toMatchObject({ status: 403, details: { reason: "cap_override_forbidden" } });
      // Refused before ever reserving spend or calling the provider.
      expect(mockedExecute).not.toHaveBeenCalled();
      const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(companyRow.spentMonthlyCents).toBe(0);
    });

    it("releases the spend reservation (and the company's cached spend) if the provider call fails after the budget check passes", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      mockedExecute.mockRejectedValueOnce(new Error("upstream boom"));

      await expect(
        mediaStudioDirectService(db).createPicture(companyId, { userId: "owner-user", isCompanyAdmin: true }, { prompt: "a cat", provider: "fal" }),
      ).rejects.toThrow();

      const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(companyRow.spentMonthlyCents).toBe(0);
      const remainingEvents = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
      expect(remainingEvents).toHaveLength(0);
      const remainingCreations = await db.select().from(mediaStudioDirectCreations).where(eq(mediaStudioDirectCreations.companyId, companyId));
      expect(remainingCreations).toHaveLength(0);
    });

    it("serializes the shared direct-create cap across two different companies racing it concurrently (DUR-4341)", async () => {
      const pictureCost = MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal;
      const companyA = await seedCompany({ budgetMonthlyCents: 100_000 });
      const companyB = await seedCompany({ budgetMonthlyCents: 100_000 });

      // Other tests in this file (and other billing codes' events) may already
      // have left rows behind -- set the cap relative to whatever is already
      // there so this test is self-contained regardless of execution order.
      const [baseline] = await db
        .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(eq(costEvents.billingCode, MEDIA_STUDIO_DIRECT_BILLING_CODE));
      const baselineCents = Number(baseline?.total ?? 0);
      await setMediaStudioConfig({ directCreateMonthlyCapCents: baselineCents + pictureCost });

      // DUR-4341: exposed only for this test -- createPicture et al. would
      // also fail on the unrelated per-company Fal-secret-ownership check,
      // since the plugin config's falKeySecretRef can only ever belong to
      // one company. reserveSpendForTest isolates the spend gate itself.
      type TestService = {
        reserveSpendForTest: (
          companyId: string,
          actor: { userId: string; isCompanyAdmin: boolean },
          estimateCents: number,
          confirmBudgetCapCents: number | undefined,
          params: { provider: string; model: string; billingCode: string },
        ) => Promise<{ costEventId: string }>;
        releaseReservationForTest: (companyId: string, costEventId: string) => Promise<void>;
      };
      // Company A's instance is given an artificial delay right after it takes
      // the shared-cap advisory lock, widening the race window deterministically
      // instead of relying on incidental timing for the two calls to overlap.
      // Without DUR-4341's fix, company B holds no lock that blocks on A's delay,
      // so it reads the same pre-insert shared total and wrongly passes too.
      const directA = mediaStudioDirectService(db, { testOnlyDelayMsAfterSharedCapLock: 300 }) as unknown as TestService;
      const directB = mediaStudioDirectService(db) as unknown as TestService;
      const params = { provider: "fal", model: "pending", billingCode: MEDIA_STUDIO_DIRECT_BILLING_CODE };

      const companyIds = [companyA, companyB];
      const results = await Promise.allSettled([
        directA.reserveSpendForTest(companyA, { userId: "owner-a", isCompanyAdmin: true }, pictureCost, undefined, params),
        (async () => {
          // Give A a head start acquiring the shared lock first, so the fix's
          // serialization (and the bug's absence of it) is deterministic.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return directB.reserveSpendForTest(companyB, { userId: "owner-b", isCompanyAdmin: true }, pictureCost, undefined, params);
        })(),
      ]);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ costEventId: string }> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      const winnerIndex = results.findIndex((r) => r.status === "fulfilled");

      // With the shared cap sized for exactly one more reservation, only one
      // of the two concurrent companies may win it; the fix (DUR-4341's
      // second, fixed-key advisory lock) is what makes this deterministic --
      // without it, both read the same pre-insert total and both pass.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ status: 422, details: { reason: "direct_create_cap" } });

      const [finalTotal] = await db
        .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(eq(costEvents.billingCode, MEDIA_STUDIO_DIRECT_BILLING_CODE));
      expect(Number(finalTotal?.total ?? 0)).toBe(baselineCents + pictureCost);

      await directA.releaseReservationForTest(companyIds[winnerIndex]!, fulfilled[0]!.value.costEventId);
    });
  });

  describe("createPicture success path", () => {
    it("generates, saves the file, records a cost event, and rolls the spend into the company budget", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      mockedExecute.mockResolvedValueOnce(
        fakeFalResponse({ images: [{ url: "data:image/jpeg;base64,Zm9vYmFy", content_type: "image/jpeg", width: 1024, height: 768 }], seed: 42 }),
      );
      // DUR-4455: then Fal's published price for the endpoint ($0.02 per megapixel).
      mockedExecute.mockResolvedValueOnce(fakeFalResponse({ prices: [{ endpoint_id: "fal-ai/flux/schnell", unit_price: 0.02, unit: "megapixels", currency: "USD" }] }));

      const result = await mediaStudioDirectService(db).createPicture(
        companyId,
        { userId: "owner-user", isCompanyAdmin: true },
        { prompt: "a friendly robot", provider: "fal" },
      );

      // 1024x768 = 0.786432 MP x $0.02 = 15,729 micro-USD = 2 cents.
      expect(result.costCents).toBe(2);
      expect(result.seed).toBe(42);
      expect(result.fileId).toBeTruthy();
      expect(result.contentPath).toBe(`/api/attachments/${result.fileId}/content`);
      // Generation + the pricing lookup; the picture came back as a data URL,
      // so there is no fetch for the image bytes.
      expect(mockedExecute).toHaveBeenCalledTimes(2);

      const [creationRow] = await db
        .select()
        .from(mediaStudioDirectCreations)
        .where(and(eq(mediaStudioDirectCreations.companyId, companyId), eq(mediaStudioDirectCreations.fileId, result.fileId)));
      expect(creationRow).toBeTruthy();
      expect(creationRow!.kind).toBe("picture");
      expect(creationRow!.createdByUserId).toBe("owner-user");
      expect(creationRow!.costCents).toBe(2);

      const [costEventRow] = await db.select().from(costEvents).where(eq(costEvents.id, creationRow!.costEventId!));
      expect(costEventRow.agentId).toBeNull();
      expect(costEventRow.createdByUserId).toBe("owner-user");
      expect(costEventRow.costCents).toBe(2);
      expect(costEventRow.costMicroUsd).toBe(15_729);
      expect(costEventRow.costSource).toBe("estimate");

      const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(companyRow.spentMonthlyCents).toBe(2);
    });
  });

  describe("settleSpend (DUR-4455: Edit-tab Fal actions settle to the actual price)", () => {
    it("replaces a reservation's estimate with Fal's published price and recomputes company spend", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      const direct = mediaStudioDirectService(db);
      const { costEventId } = await direct.reserveSpend(
        companyId,
        { userId: "owner-user", isCompanyAdmin: true },
        MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal,
        undefined,
        { provider: "fal", model: "edit:inpaint", billingCode: MEDIA_STUDIO_DIRECT_BILLING_CODE },
      );

      mockedExecute.mockResolvedValueOnce(
        fakeFalResponse({ prices: [{ endpoint_id: "fal-ai/flux-pro/v1/fill", unit_price: 0.05, unit: "image", currency: "USD" }] }),
      );
      const outcome = await direct.settleSpend(companyId, costEventId, "fal-ai/flux-pro/v1/fill", { images: 1 });
      expect(outcome).toEqual({ settled: true, costCents: 5 });

      const [row] = await db.select().from(costEvents).where(eq(costEvents.id, costEventId));
      expect(row.costCents).toBe(5);
      expect(row.costMicroUsd).toBe(50_000);
      expect(row.costSource).toBe("estimate");

      const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(companyRow.spentMonthlyCents).toBe(5);
    });

    it("leaves the reservation's estimate standing when pricing is unavailable", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      const direct = mediaStudioDirectService(db);
      const { costEventId } = await direct.reserveSpend(
        companyId,
        { userId: "owner-user", isCompanyAdmin: true },
        MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal,
        undefined,
        { provider: "fal", model: "edit:inpaint", billingCode: MEDIA_STUDIO_DIRECT_BILLING_CODE },
      );
      mockedExecute.mockResolvedValueOnce({ status: 403, statusText: "Forbidden", headers: {}, body: "", bodyBytes: Buffer.from("") });

      const outcome = await direct.settleSpend(companyId, costEventId, "fal-ai/flux-pro/v1/fill", { images: 1 });
      expect(outcome).toEqual({ settled: false });

      const [row] = await db.select().from(costEvents).where(eq(costEvents.id, costEventId));
      expect(row.costCents).toBe(MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal);
    });

    it("refuses to settle a reservation belonging to a different company", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const otherCompanyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      const direct = mediaStudioDirectService(db);
      const { costEventId } = await direct.reserveSpend(
        companyId,
        { userId: "owner-user", isCompanyAdmin: true },
        MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal,
        undefined,
        { provider: "fal", model: "edit:inpaint", billingCode: MEDIA_STUDIO_DIRECT_BILLING_CODE },
      );
      const outcome = await direct.settleSpend(otherCompanyId, costEventId, "fal-ai/flux-pro/v1/fill", { images: 1 });
      expect(outcome).toEqual({ settled: false });
      expect(mockedExecute).not.toHaveBeenCalled();
    });
  });

  describe("createAudio success path", () => {
    it("generates via Fal's async queue (submit, poll, fetch bytes), saves the file, and records a cost event", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      mockedExecute
        .mockResolvedValueOnce(fakeFalResponse({ request_id: "req-1" }))
        .mockResolvedValueOnce(fakeFalResponse({ status: "COMPLETED" }))
        .mockResolvedValueOnce(fakeFalResponse({ audio: { url: "https://fal.media/files/audio.mp3", content_type: "audio/mpeg" } }))
        .mockResolvedValueOnce(fakeFalResponse({ prices: [{ endpoint_id: "cassetteai/music-generator", unit_price: 0.01, unit: "second", currency: "USD" }] }))
        .mockResolvedValueOnce(fakeBinaryResponse("audio/mpeg", Buffer.from("fake-audio-bytes")));

      const result = await mediaStudioDirectService(db).createAudio(
        companyId,
        { userId: "owner-user" },
        { prompt: "a short upbeat jingle", provider: "fal", mode: "music", durationSeconds: 3 },
      );

      // 3s x $0.01/s = 30,000 micro-USD = 3 cents (replaces the 45-cent estimate).
      const expectedCostCents = 3;
      expect(result.costCents).toBe(expectedCostCents);
      expect(result.fileId).toBeTruthy();
      expect(result.contentType).toBe("audio/mpeg");
      expect(result.contentPath).toBe(`/api/attachments/${result.fileId}/content`);
      // Submit + status poll + result fetch + pricing lookup + the audio-bytes fetch.
      expect(mockedExecute).toHaveBeenCalledTimes(5);

      const [creationRow] = await db
        .select()
        .from(mediaStudioDirectCreations)
        .where(and(eq(mediaStudioDirectCreations.companyId, companyId), eq(mediaStudioDirectCreations.fileId, result.fileId)));
      expect(creationRow).toBeTruthy();
      expect(creationRow!.kind).toBe("audio");
      expect(creationRow!.costCents).toBe(expectedCostCents);

      const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(companyRow.spentMonthlyCents).toBe(expectedCostCents);
    });
  });

  describe("history", () => {
    it("returns only the calling user's own creations, newest first", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      mockedExecute.mockResolvedValue(
        fakeFalResponse({ images: [{ url: "data:image/jpeg;base64,Zm9vYmFy", content_type: "image/jpeg" }], seed: 1 }),
      );

      const direct = mediaStudioDirectService(db);
      const first = await direct.createPicture(companyId, { userId: "user-a", isCompanyAdmin: false }, { prompt: "first", provider: "fal" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await direct.createPicture(companyId, { userId: "user-a", isCompanyAdmin: false }, { prompt: "second", provider: "fal" });
      await direct.createPicture(companyId, { userId: "user-b", isCompanyAdmin: false }, { prompt: "someone else's", provider: "fal" });

      const entries = await direct.history(companyId, { userId: "user-a", isCompanyAdmin: false });
      expect(entries.map((e) => e.fileId)).toEqual([second.fileId, first.fileId]);
      expect(entries.every((e) => e.kind === "picture")).toBe(true);
    });
  });

  describe("rewritePrompt daily call cap", () => {
    it("refuses once the company has used its daily prompt-rewrite calls, before ever calling the model", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      for (let i = 0; i < 50; i++) {
        await db.insert(costEvents).values({
          companyId,
          agentId: null,
          createdByUserId: "owner-user",
          provider: "anthropic",
          biller: "anthropic",
          billingType: "metered_api",
          billingCode: MEDIA_STUDIO_DIRECT_REWRITE_BILLING_CODE,
          model: "claude-sonnet-5",
          costCents: 1,
          occurredAt: new Date(),
        });
      }

      await expect(
        mediaStudioDirectService(db).rewritePrompt(companyId, { userId: "owner-user", isCompanyAdmin: true }, { prompt: "make this better" }),
      ).rejects.toMatchObject({ status: 429, details: { reason: "daily_call_cap" } });
    });
  });

  describe("route authorization", () => {
    function memberActor(companyId: string, membershipRole: string, userId = `user-${membershipRole}`) {
      return {
        type: "board" as const,
        source: "session",
        userId,
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole }],
      };
    }
    function agentActor(companyId: string) {
      return { type: "agent" as const, agentId: randomUUID(), companyId, source: "agent_key", runId: null };
    }

    function buildApp(actor: Record<string, unknown>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as express.Request & { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", mediaStudioDirectRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("refuses a viewer's estimate request (write path)", async () => {
      const companyId = await seedCompany();
      const app = buildApp(memberActor(companyId, "viewer"));

      const res = await request(app)
        .post(`/api/companies/${companyId}/media-studio/direct/estimate`)
        .send({ kind: "picture", provider: "fal" });

      expect(res.status).toBe(403);
    });

    it("refuses an agent API key outright (board-only)", async () => {
      const companyId = await seedCompany();
      const app = buildApp(agentActor(companyId));

      const res = await request(app)
        .post(`/api/companies/${companyId}/media-studio/direct/estimate`)
        .send({ kind: "picture", provider: "fal" });

      expect(res.status).toBe(403);
    });

    it("lets an operator estimate a cost", async () => {
      const companyId = await seedCompany();
      const app = buildApp(memberActor(companyId, "operator"));

      const res = await request(app)
        .post(`/api/companies/${companyId}/media-studio/direct/estimate`)
        .send({ kind: "picture", provider: "fal" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kind: "picture", provider: "fal", estimatedCostCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal });
    });

    it("still lets a viewer read history (GET is a safe method)", async () => {
      const companyId = await seedCompany();
      const app = buildApp(memberActor(companyId, "viewer"));

      const res = await request(app).get(`/api/companies/${companyId}/media-studio/direct/history`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
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
  const tmpDir = path.join(os.tmpdir(), `paperclip-dur4329-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
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
  });

  beforeEach(() => {
    mockedExecute.mockReset();
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
        mediaStudioDirectService(db).createPicture(companyId, { userId: "owner-user" }, { prompt: "a cat", provider: "fal" }),
      ).rejects.toMatchObject({ status: 422, details: { reason: "company_budget" } });
      expect(mockedExecute).not.toHaveBeenCalled();
    });

    it("refuses a picture when it would exceed the Media Studio direct-create plugin cap, even with company budget to spare", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      await setMediaStudioConfig({ directCreateMonthlyCapCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal - 1 });

      await expect(
        mediaStudioDirectService(db).createPicture(companyId, { userId: "owner-user" }, { prompt: "a cat", provider: "fal" }),
      ).rejects.toMatchObject({ status: 422, details: { reason: "direct_create_cap" } });
      expect(mockedExecute).not.toHaveBeenCalled();
    });

    it("lets confirmBudgetCapCents override the plugin cap for a single call", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId, directCreateMonthlyCapCents: MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal - 1 });

      mockedExecute.mockResolvedValueOnce(
        fakeFalResponse({ images: [{ url: "data:image/jpeg;base64,Zm9vYmFy", content_type: "image/jpeg" }], seed: 7 }),
      );

      const result = await mediaStudioDirectService(db).createPicture(
        companyId,
        { userId: "owner-user" },
        { prompt: "a cat", provider: "fal", confirmBudgetCapCents: 1_000 },
      );
      expect(result.costCents).toBe(MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal);
    });
  });

  describe("createPicture success path", () => {
    it("generates, saves the file, records a cost event, and rolls the spend into the company budget", async () => {
      const companyId = await seedCompany({ budgetMonthlyCents: 100_000 });
      const secretId = await seedFalSecret(companyId);
      await setMediaStudioConfig({ falKeySecretRef: secretId });

      mockedExecute.mockResolvedValueOnce(
        fakeFalResponse({ images: [{ url: "data:image/jpeg;base64,Zm9vYmFy", content_type: "image/jpeg" }], seed: 42 }),
      );

      const result = await mediaStudioDirectService(db).createPicture(
        companyId,
        { userId: "owner-user" },
        { prompt: "a friendly robot", provider: "fal" },
      );

      expect(result.costCents).toBe(MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal);
      expect(result.seed).toBe(42);
      expect(result.fileId).toBeTruthy();
      expect(result.contentPath).toBe(`/api/attachments/${result.fileId}/content`);
      // Exactly one outbound call: the picture came back as a data URL, so
      // there is no second fetch for the image bytes.
      expect(mockedExecute).toHaveBeenCalledTimes(1);

      const [creationRow] = await db
        .select()
        .from(mediaStudioDirectCreations)
        .where(and(eq(mediaStudioDirectCreations.companyId, companyId), eq(mediaStudioDirectCreations.fileId, result.fileId)));
      expect(creationRow).toBeTruthy();
      expect(creationRow!.kind).toBe("picture");
      expect(creationRow!.createdByUserId).toBe("owner-user");
      expect(creationRow!.costCents).toBe(MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal);

      const [costEventRow] = await db.select().from(costEvents).where(eq(costEvents.id, creationRow!.costEventId!));
      expect(costEventRow.agentId).toBeNull();
      expect(costEventRow.createdByUserId).toBe("owner-user");
      expect(costEventRow.costCents).toBe(MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal);

      const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(companyRow.spentMonthlyCents).toBe(MEDIA_STUDIO_DIRECT_PICTURE_COST_CENTS.fal);
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
      const first = await direct.createPicture(companyId, { userId: "user-a" }, { prompt: "first", provider: "fal" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await direct.createPicture(companyId, { userId: "user-a" }, { prompt: "second", provider: "fal" });
      await direct.createPicture(companyId, { userId: "user-b" }, { prompt: "someone else's", provider: "fal" });

      const entries = await direct.history(companyId, { userId: "user-a" });
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
        mediaStudioDirectService(db).rewritePrompt(companyId, { userId: "owner-user" }, { prompt: "make this better" }),
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

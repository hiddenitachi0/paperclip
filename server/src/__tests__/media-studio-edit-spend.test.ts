import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { MEDIA_STUDIO_EDIT_BILLING_CODE, estimateMediaStudioDirectCostCents, estimateMediaStudioEditCostCents } from "@paperclipai/shared";
import { companies, companyMemberships, costEvents, createDb, plugins } from "@paperclipai/db";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import workerManifest from "../../../packages/plugins/media-studio/src/manifest.js";

/**
 * DUR-4441: paid Edit-tab actions reserve spend through the host against
 * the same company budget / shared cap as the Create tab.
 */

const PRICE = estimateMediaStudioEditCostCents("inpaint");
const KEY = "paperclip.media-studio";
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

function eventBusStub() {
  return { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }) } as any;
}

describe("edit prices match the Create tab's picture estimate", () => {
  it("is one identical number for every edit action", () => {
    const create = estimateMediaStudioDirectCostCents({ kind: "picture", provider: "fal" }).estimatedCostCents;
    for (const a of ["segment", "inpaint", "remove-background", "upscale", "restore", "variation", "prompt-edit"] as const) {
      expect(estimateMediaStudioEditCostCents(a)).toBe(create);
    }
  });
});

d("host billing capability for paid edits", () => {
  let db!: ReturnType<typeof createDb>;
  let stop: (() => Promise<void>) | null = null;
  let pluginRowId = "";

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("media-studio-edit-spend");
    stop = started.cleanup;
    db = createDb(started.connectionString);
    const [row] = await db
      .insert(plugins)
      .values({
        pluginKey: KEY,
        packageName: "@paperclipai/plugin-media-studio",
        version: "1.0.0",
        manifestJson: { id: KEY, apiVersion: 1, version: "1.0.0", displayName: "MS", description: "x", author: "x", categories: ["automation"], capabilities: [], entrypoints: { worker: "w.js" } } as unknown as PaperclipPluginManifestV1,
        status: "ready",
      })
      .returning();
    pluginRowId = row!.id;
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  const setConfig = (configJson: Record<string, unknown>) => pluginRegistryService(db).upsertConfig(pluginRowId, { configJson });
  const host = () => buildHostServices(db, pluginRowId, KEY, eventBusStub()).billing;

  async function seed(budgetMonthlyCents = 100_000) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Edit Co", issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, budgetMonthlyCents });
    const admin = `admin-${randomUUID()}`;
    const operator = `op-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: admin, status: "active", membershipRole: "admin" },
      { companyId, principalType: "user", principalId: operator, status: "active", membershipRole: "operator" },
    ]);
    return { companyId, admin, operator };
  }
  const spent = async (companyId: string) => (await db.select().from(companies).where(eq(companies.id, companyId)))[0]!.spentMonthlyCents;

  it("a successful reservation writes a cost event and updates the company's spend", async () => {
    await setConfig({});
    const { companyId, operator } = await seed();
    const r = await host().reserveMediaStudioDirectSpend({ companyId, userId: operator, action: "upscale" });
    expect(r).toMatchObject({ allowed: true });
    const rows = await db.select().from(costEvents).where(eq(costEvents.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costCents: PRICE, billingCode: MEDIA_STUDIO_EDIT_BILLING_CODE, createdByUserId: operator });
    expect(await spent(companyId)).toBe(PRICE);
  });

  it("release gives the reservation back", async () => {
    await setConfig({});
    const { companyId, operator } = await seed();
    const r = await host().reserveMediaStudioDirectSpend({ companyId, userId: operator, action: "inpaint" });
    if (!r.allowed) throw new Error("expected allowed");
    await host().releaseMediaStudioDirectSpend({ companyId, reservationId: r.reservationId });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(0);
    expect(await spent(companyId)).toBe(0);
  });

  it("refuses over the company's monthly budget in plain language, and an admin override does not help", async () => {
    await setConfig({});
    const { companyId, admin } = await seed(PRICE - 1);
    const r = await host().reserveMediaStudioDirectSpend({ companyId, userId: admin, action: "inpaint", confirmBudgetCapCents: 1_000_000 });
    expect(r).toMatchObject({ allowed: false, reason: "company_budget" });
    expect((r as { message: string }).message).toMatch(/monthly budget/);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(0);
  });

  it("refuses over the shared cap; a non-admin cannot override, an admin can", async () => {
    await setConfig({ directCreateMonthlyCapCents: PRICE - 1 });
    const { companyId, admin, operator } = await seed();
    expect(await host().reserveMediaStudioDirectSpend({ companyId, userId: operator, action: "restore" })).toMatchObject({ allowed: false, reason: "direct_create_cap" });
    expect(await host().reserveMediaStudioDirectSpend({ companyId, userId: operator, action: "restore", confirmBudgetCapCents: 1_000_000 })).toMatchObject({ allowed: false, reason: "cap_override_forbidden" });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(0);

    const ok = await host().reserveMediaStudioDirectSpend({ companyId, userId: admin, action: "restore", confirmBudgetCapCents: 1_000 });
    expect(ok).toMatchObject({ allowed: true });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(1);
  });

  it("derives admin status from real membership: a stranger or removed member is refused", async () => {
    await setConfig({ directCreateMonthlyCapCents: PRICE - 1 });
    const { companyId } = await seed();
    const r = await host().reserveMediaStudioDirectSpend({ companyId, userId: "someone-else", action: "restore", confirmBudgetCapCents: 1_000 });
    expect(r).toMatchObject({ allowed: false, reason: "not_a_member" });
  });

  it("rejects an unknown action and never lets the caller set a price", async () => {
    await setConfig({});
    const { companyId, operator } = await seed();
    await expect(host().reserveMediaStudioDirectSpend({ companyId, userId: operator, action: "free-lunch" })).rejects.toThrow(/Unknown edit action/);
  });

  it("cannot release another company's or a non-edit cost event", async () => {
    await setConfig({});
    const a = await seed();
    const b = await seed();
    const r = await host().reserveMediaStudioDirectSpend({ companyId: a.companyId, userId: a.operator, action: "inpaint" });
    if (!r.allowed) throw new Error("expected allowed");
    await host().releaseMediaStudioDirectSpend({ companyId: b.companyId, reservationId: r.reservationId });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, a.companyId))).toHaveLength(1);
  });
});

describe("worker: paid edits go through the reservation", () => {
  const COMPANY = "11111111-1111-4111-8111-111111111111";
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const MASK = "data:image/png;base64,iVBORw0KGgo=";

  async function setup(overrides: Partial<{ allowed: boolean }> = {}) {
    const harness = createTestHarness({ manifest: workerManifest, config: { provider: "mock", falKeySecretRef: "fal-ref", sogniKeySecretRef: "sogni-ref" } });
    await plugin.definition.setup(harness.ctx);
    const reserve = vi.fn(async () =>
      overrides.allowed === false
        ? ({ allowed: false as const, message: "That would go over this month's budget.", reason: "company_budget" })
        : ({ allowed: true as const, reservationId: "res-1" }),
    );
    const release = vi.fn(async () => {});
    (harness.ctx as any).billing = { reserveMediaStudioDirectSpend: reserve, releaseMediaStudioDirectSpend: release };
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider exploded");
    });
    (harness.ctx.http as any).fetch = fetchSpy;
    (harness.ctx.secrets as any).resolve = async () => "secret-value";
    return { harness, reserve, release, fetchSpy };
  }
  const as = { companyId: COMPANY, actor: { type: "user" as const, userId: "user-1" } };

  it("a refused reservation stops the edit before any provider call, with the plain message", async () => {
    const { harness, reserve, fetchSpy } = await setup({ allowed: false });
    await expect(harness.performAction("edit.inpaint", { imageDataUrl: PNG, maskDataUrl: MASK, mode: "remove" }, as)).rejects.toThrow(/over this month's budget/);
    await expect(harness.performAction("edit.fal", { imageDataUrl: PNG, prompt: "x" }, as)).rejects.toThrow(/over this month's budget/);
    await expect(harness.performAction("edit.segment", { imageDataUrl: PNG, text: "cat" }, as)).rejects.toThrow(/over this month's budget/);
    await expect(harness.performAction("edit.sogni", { tool: "sogni-upscale-image", imageDataUrl: PNG, scale: 2 }, as)).rejects.toThrow(/over this month's budget/);
    expect(reserve.mock.calls.map((c) => (c as any)[1].action)).toEqual(["inpaint", "variation", "segment", "upscale"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a provider failure after reserving releases the reservation", async () => {
    const { harness, reserve, release } = await setup();
    await expect(harness.performAction("edit.inpaint", { imageDataUrl: PNG, maskDataUrl: MASK, mode: "remove" }, as)).rejects.toThrow();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(COMPANY, "res-1");
  });

  it("passes the client's override to the host; the plugin itself never asserts admin", async () => {
    const { harness, reserve } = await setup();
    await expect(harness.performAction("edit.fal", { imageDataUrl: PNG, prompt: "x", confirmBudgetCapCents: 500 }, as)).rejects.toThrow();
    expect(reserve).toHaveBeenCalledWith(COMPANY, { userId: "user-1", action: "variation", confirmBudgetCapCents: 500 });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createDb, companies, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { videoStorylineSettingsService } from "../services/video-storyline-settings.ts";

/**
 * DUR-4127: the required "ships default off" flag. isEnabled/assertEnabled
 * must read false for a company with no settings row, and for one whose row
 * has never set this specific key -- absence, not an explicit false, is the
 * only signal this service trusts (see video-storyline-settings.ts's doc
 * comment on why it owns exactly this one key).
 */
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping video storyline settings service tests: ${support.reason ?? "unsupported environment"}`);
}

d("videoStorylineSettingsService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("video-storyline-settings");
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Settings Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("defaults to off for a company with no settings row", async () => {
    const companyId = await seedCompany();
    const svc = videoStorylineSettingsService(db);
    expect(await svc.isEnabled(companyId)).toBe(false);
    await expect(svc.assertEnabled(companyId)).rejects.toMatchObject({ status: 422 });
  });

  it("turns on and off, scoped to one company", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const svc = videoStorylineSettingsService(db);

    await svc.setEnabled(companyA, true);
    expect(await svc.isEnabled(companyA)).toBe(true);
    expect(await svc.isEnabled(companyB)).toBe(false);
    await expect(svc.assertEnabled(companyA)).resolves.toBeUndefined();

    await svc.setEnabled(companyA, false);
    expect(await svc.isEnabled(companyA)).toBe(false);
  });
});

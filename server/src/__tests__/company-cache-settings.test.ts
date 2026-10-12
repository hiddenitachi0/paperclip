/** DUR-4471: lazy-row defaults and update round-trip for company cache settings. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyCacheSettings, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyCacheSettingsService } from "../services/company-cache-settings.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("company cache settings (DUR-4471)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cache-settings-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function newCompany() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Co", issuePrefix: `C${id.slice(0, 6).replace(/-/g, "")}` });
    return id;
  }

  it("defaults to off without creating a row", async () => {
    const id = await newCompany();
    const s = await companyCacheSettingsService(db).get(id);
    expect(s).toEqual({
      companyId: id,
      enabled: false,
      schedulingEnabled: true,
      handoffEnabled: true,
      handoffTokenThreshold: 150000,
      cacheLifetimeMinutes: null,
    });
    expect(await db.select().from(companyCacheSettings)).not.toContainEqual(expect.objectContaining({ companyId: id }));
  });

  it("round-trips partial updates and keeps other fields", async () => {
    const id = await newCompany();
    const svc = companyCacheSettingsService(db);
    await svc.update(id, { enabled: true, handoffTokenThreshold: 90000 });
    await svc.update(id, { cacheLifetimeMinutes: 60 });
    expect(await svc.get(id)).toMatchObject({ enabled: true, handoffTokenThreshold: 90000, cacheLifetimeMinutes: 60, handoffEnabled: true });
    await svc.update(id, { cacheLifetimeMinutes: null, enabled: false });
    expect(await svc.get(id)).toMatchObject({ enabled: false, cacheLifetimeMinutes: null, handoffTokenThreshold: 90000 });
  });

  it("is scoped per company", async () => {
    const a = await newCompany();
    const b = await newCompany();
    await companyCacheSettingsService(db).update(a, { enabled: true });
    expect((await companyCacheSettingsService(db).get(b)).enabled).toBe(false);
  });
});

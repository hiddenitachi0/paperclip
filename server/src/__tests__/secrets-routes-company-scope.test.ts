import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let secretRoutes: typeof import("../routes/secrets.js").secretRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres secrets company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-348 (DUR-277 Wave 2): proves secretRoutes is genuinely scoped end-to-end
// over a real HTTP request -- a real reserved Postgres connection, a real
// `app.current_company_id` session claim, and that the claim never bleeds
// one company's secrets into another's response across pooled-connection
// reuse. See dashboard-routes-company-scope.test.ts for the original of this
// pattern (DUR-277).
describeEmbeddedPostgres("secretRoutes company-scope wiring (DUR-348)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secrets-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/secrets.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/secrets.js")>("../routes/secrets.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    secretRoutes = routes.secretRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyIds: string[]) {
    if (!secretRoutes || !errorHandler) {
      throw new Error("secrets route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: randomUUID(),
        companyIds,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithSecrets(secretNames: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (const name of secretNames) {
      await db.insert(companySecrets).values({
        id: randomUUID(),
        companyId,
        key: name.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
        name,
        provider: "local_encrypted",
        status: "active",
        managedMode: "paperclip_managed",
      });
    }
    return companyId;
  }

  it("returns the requesting company's own secrets over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithSecrets(["OPENAI_API_KEY", "STRIPE_KEY"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/secrets`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((secret: { companyId: string }) => secret.companyId === companyId)).toBe(true);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/secrets");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithSecrets(["A_ONLY_SECRET"]);
    const companyB = await seedCompanyWithSecrets(["B_ONLY_SECRET_1", "B_ONLY_SECRET_2"]);
    const app = createApp([companyA, companyB]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/secrets`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].name).toBe("A_ONLY_SECRET");

      const resB = await request(app).get(`/api/companies/${companyB}/secrets`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.every((secret: { companyId: string }) => secret.companyId === companyB)).toBe(true);
    }
  });
});

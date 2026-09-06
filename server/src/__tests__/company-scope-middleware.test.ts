import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createRequestScopedDb, type Db } from "@paperclipai/db";
import { companyScope, companyScopeFromBody, companyScopeFromParam } from "../middleware/company-scope.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-scope middleware tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-347: proves the consolidated company-scope middleware primitives --
// companyScope (the canonical resolver-based core) and its
// companyScopeFromParam/companyScopeFromBody convenience wrappers -- all
// establish a real claim over a real reserved connection, and all reject
// before ever reserving one when the resolved companyId is missing/invalid.
// dashboard-routes-company-scope.test.ts already proves companyScopeFromParam
// end-to-end via the real dashboard route; this file covers the other
// resolver shapes later DUR-277 waves need (body-based, async lookup-based)
// so they don't have to reimplement/re-verify the reserve/claim/release
// sequence themselves.
describeEmbeddedPostgres("company-scope middleware (DUR-347)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-scope-middleware-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function currentCompanyClaimRoute() {
    return async (req: express.Request, res: express.Response) => {
      const scopedDb = createRequestScopedDb(db);
      const [row] = (await scopedDb.execute(
        sql`select current_setting('app.current_company_id', true) as cid`,
      )) as unknown as { cid: string }[];
      res.json({ cid: row?.cid ?? null });
    };
  }

  it("companyScopeFromParam establishes the claim from req.params.companyId", async () => {
    const companyId = randomUUID();
    const app = express();
    app.get("/companies/:companyId/probe", companyScopeFromParam(db), currentCompanyClaimRoute());
    app.use(errorHandler);

    const res = await request(app).get(`/companies/${companyId}/probe`);

    expect(res.status).toBe(200);
    expect(res.body.cid).toBe(companyId);
  });

  it("companyScopeFromParam rejects a non-UUID param with 400 before reserving a connection", async () => {
    const app = express();
    app.get("/companies/:companyId/probe", companyScopeFromParam(db), currentCompanyClaimRoute());
    app.use(errorHandler);

    const res = await request(app).get("/companies/not-a-uuid/probe");

    expect(res.status).toBe(400);
  });

  it("companyScopeFromBody establishes the claim from req.body.companyId", async () => {
    const companyId = randomUUID();
    const app = express();
    app.use(express.json());
    app.post("/probe", companyScopeFromBody(db), currentCompanyClaimRoute());
    app.use(errorHandler);

    const res = await request(app).post("/probe").send({ companyId });

    expect(res.status).toBe(200);
    expect(res.body.cid).toBe(companyId);
  });

  it("companyScopeFromBody rejects a missing body companyId with 400 before reserving a connection", async () => {
    const app = express();
    app.use(express.json());
    app.post("/probe", companyScopeFromBody(db), currentCompanyClaimRoute());
    app.use(errorHandler);

    const res = await request(app).post("/probe").send({});

    expect(res.status).toBe(400);
  });

  it("companyScope() supports an async lookup-based resolver, for (b)-category routes", async () => {
    const companyId = randomUUID();
    const lookupCompanyIdByWidgetId = async (_widgetId: string) => {
      // stand-in for a real DB lookup a Wave 2/3 route would do here
      await Promise.resolve();
      return companyId;
    };

    const app = express();
    app.get(
      "/widgets/:widgetId/probe",
      companyScope(db, async (req) => lookupCompanyIdByWidgetId(req.params.widgetId)),
      currentCompanyClaimRoute(),
    );
    app.use(errorHandler);

    const res = await request(app).get("/widgets/some-widget/probe");

    expect(res.status).toBe(200);
    expect(res.body.cid).toBe(companyId);
  });

  it("companyScope() rejects before reserving a connection when the async resolver returns an invalid companyId", async () => {
    const app = express();
    app.get(
      "/widgets/:widgetId/probe",
      companyScope(db, async () => "not-a-uuid"),
      currentCompanyClaimRoute(),
    );
    app.use(errorHandler);

    const res = await request(app).get("/widgets/some-widget/probe");

    expect(res.status).toBe(400);
  });
});

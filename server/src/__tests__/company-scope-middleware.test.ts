import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
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
  }, 60_000);

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

  // DUR-3931: end-to-end version of the production/CI outage. A browser
  // aborts every in-flight fetch when the user navigates or reloads, which
  // makes `res` emit `close` without `finish` -- the exact condition
  // companyScope() turns into a ConnectionReleaseUnsafeError. Each of those
  // used to burn one pool connection permanently, so once `max` (10 by
  // default) reloads had happened the server stopped serving every
  // company-scoped route: postgres.js's reserve() awaits a promise with no
  // timeout, so requests hung instead of failing. In CI this looked like a
  // flaky Playwright spec -- the page after a reload showed only
  // "Loading..." until the spec timed out -- because whether a run crossed
  // `max` aborts depended on timing.
  //
  // This drives it through a real HTTP server (supertest cannot abort a
  // socket mid-response) against a deliberately tiny pool, so "more aborts
  // than connections" is reached in a few requests instead of ten.
  it("keeps serving company-scoped requests after more client aborts than the pool has connections", async () => {
    const poolMax = 2;
    const abortCount = poolMax + 3;

    const previousPoolMax = process.env.PAPERCLIP_DB_POOL_MAX;
    process.env.PAPERCLIP_DB_POOL_MAX = String(poolMax);
    let smallPoolDb: Db;
    try {
      smallPoolDb = createDb(tempDb!.connectionString);
    } finally {
      if (previousPoolMax === undefined) delete process.env.PAPERCLIP_DB_POOL_MAX;
      else process.env.PAPERCLIP_DB_POOL_MAX = previousPoolMax;
    }

    const app = express();
    app.get("/companies/:companyId/slow", companyScopeFromParam(smallPoolDb), async (_req, res) => {
      const scopedDb = createRequestScopedDb(smallPoolDb);
      // Long enough that the client can abort while the handler is genuinely
      // mid-query, which is the case that made releasing look unsafe.
      await scopedDb.execute(sql`select pg_sleep(0.3)`);
      res.json({ ok: true });
    });
    app.get("/companies/:companyId/probe", companyScopeFromParam(smallPoolDb), async (_req, res) => {
      const scopedDb = createRequestScopedDb(smallPoolDb);
      const [row] = (await scopedDb.execute(
        sql`select current_setting('app.current_company_id', true) as cid`,
      )) as unknown as { cid: string }[];
      res.json({ cid: row?.cid ?? null });
    });
    app.use(errorHandler);

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    /** Issue a request and destroy its socket mid-flight, exactly as a browser does on navigate. */
    const abortMidFlight = (path: string) =>
      new Promise<void>((resolve) => {
        const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
          res.resume();
        });
        req.on("error", () => resolve());
        req.on("socket", (socket) => {
          socket.on("connect", () => setTimeout(() => req.destroy(), 30));
        });
        req.end();
        setTimeout(resolve, 120);
      });

    try {
      for (let i = 0; i < abortCount; i += 1) {
        await abortMidFlight(`/companies/${randomUUID()}/slow`);
      }

      // Give the aborted requests' teardown (queued behind their in-flight
      // pg_sleep) time to finish returning connections to the pool.
      await new Promise((resolve) => setTimeout(resolve, 750));

      const companyId = randomUUID();
      const controller = new AbortController();
      // Generous, because this is a liveness assertion, not a latency one:
      // if the pool leaked, reserve() never resolves and no budget helps.
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/companies/${companyId}/probe`, {
          signal: controller.signal,
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { cid: string }).cid).toBe(companyId);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await smallPoolDb.$client.end({ timeout: 5 });
    }
  }, 60_000);
});

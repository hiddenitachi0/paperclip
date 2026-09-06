import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMcpTools, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let mcpToolLibraryRoutes: typeof import("../routes/mcp-tool-library.js").mcpToolLibraryRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mcp-tool-library company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 wave): proves mcpToolLibraryRoutes is genuinely
// scoped end-to-end over a real HTTP request -- a real reserved Postgres
// connection, a real `app.current_company_id` session claim, and that the
// claim never bleeds one company's tool library entries into another's
// response across pooled-connection reuse. See
// secrets-routes-company-scope.test.ts for the original of this pattern.
describeEmbeddedPostgres("mcpToolLibraryRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-tool-library-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/mcp-tool-library.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/mcp-tool-library.js")>("../routes/mcp-tool-library.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    mcpToolLibraryRoutes = routes.mcpToolLibraryRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(companyMcpTools);
    await db.delete(agents);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Board-only throughout (see file header comment in mcp-tool-library.ts),
  // so the test actor must be a board actor -- "local_implicit" is the
  // special board identity that unconditionally passes assertCompanyAccess
  // without needing seeded permission/membership rows.
  function createApp(companyIds: string[]) {
    if (!mcpToolLibraryRoutes || !errorHandler) {
      throw new Error("mcp-tool-library route test dependencies were not loaded");
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
    app.use("/api", mcpToolLibraryRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithTools(names: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    for (const name of names) {
      await db.insert(companyMcpTools).values({
        id: randomUUID(),
        companyId,
        name,
        key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        description: `${name} description`,
        connection: { transport: "http", url: "https://example.com/mcp" },
      });
    }
    return companyId;
  }

  it("returns the requesting company's own tool library entries over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithTools(["Fal.ai", "Weather API"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/mcp-tools`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((tool: { companyId: string }) => tool.companyId === companyId)).toBe(true);
  });

  it("creates a tool library entry over a real HTTP request through the scope middleware", async () => {
    const companyId = await seedCompanyWithTools([]);
    const app = createApp([companyId]);

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp-tools`)
      .send({
        name: "New Tool",
        description: "A brand new tool",
        connection: { transport: "http", url: "https://example.com/mcp" },
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      name: "New Tool",
    });

    const rows = await db.select().from(companyMcpTools).where(eq(companyMcpTools.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("New Tool");
  });

  // scopeFromAgent resolves companyId from an unscoped rawDb lookup of the
  // agent row *before* the scope is known -- this is the other resolver
  // shape in this route file (alongside scopeFromCompanyIdParam and
  // scopeFromTool) and is worth its own end-to-end proof.
  it("returns an agent's assigned tools scoped to that agent's own company", async () => {
    const companyId = await seedCompanyWithTools(["Agent Tool"]);
    const [tool] = await db.select().from(companyMcpTools).where(eq(companyMcpTools.companyId, companyId));
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      mcpToolIds: [tool!.id],
    });
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/agents/${agentId}/mcp-tools`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: tool!.id, companyId });
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/mcp-tools");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const companyA = await seedCompanyWithTools(["A Only Tool"]);
    const companyB = await seedCompanyWithTools(["B Only Tool 1", "B Only Tool 2"]);
    const app = createApp([companyA, companyB]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/mcp-tools`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].name).toBe("A Only Tool");

      const resB = await request(app).get(`/api/companies/${companyB}/mcp-tools`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.every((tool: { companyId: string }) => tool.companyId === companyB)).toBe(true);
    }
  });
});

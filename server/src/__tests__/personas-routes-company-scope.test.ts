import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, personas } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let personaRoutes: typeof import("../routes/personas.js").personaRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres personas company-scope route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DUR-373 (DUR-277/DUR-348 follow-up): proves personaRoutes is genuinely
// scoped end-to-end over a real HTTP request -- a real reserved Postgres
// connection, a real `app.current_company_id` session claim, and that the
// claim never bleeds one company's personas into another's response across
// pooled-connection reuse. See secrets-routes-company-scope.test.ts for the
// original of this pattern (DUR-277/DUR-348).
describeEmbeddedPostgres("personaRoutes company-scope wiring (DUR-373)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHomeDir: string | null = null;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-personas-company-scope-");
    db = createDb(tempDb.connectionString);
    // createPersona/updatePersona sync a PERSONA.md/AGENTS.md pair onto disk
    // via agentInstructionsService -- point that at a throwaway temp home so
    // the write endpoint under test doesn't touch a real instance directory.
    paperclipHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-personas-company-scope-home-"));
    process.env.PAPERCLIP_HOME = paperclipHomeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  }, 30_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/personas.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/company-scope.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/personas.js")>("../routes/personas.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    personaRoutes = routes.personaRoutes;
    errorHandler = middleware.errorHandler;
  }, 30_000);

  afterEach(async () => {
    await db.delete(personas);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (paperclipHomeDir) {
      await fs.rm(paperclipHomeDir, { recursive: true, force: true });
    }
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
  });

  function createApp(companyIds: string[]) {
    if (!personaRoutes || !errorHandler) {
      throw new Error("persona route test dependencies were not loaded");
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
    app.use("/api", personaRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyWithPersonas(personaHandles: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 8)}`,
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const agentIds: string[] = [];
    for (const handle of personaHandles) {
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent ${handle}`,
      });
      await db.insert(personas).values({
        companyId,
        agentId,
        handle,
        status: "draft",
      });
      agentIds.push(agentId);
    }
    return { companyId, agentIds };
  }

  it("returns the requesting company's own personas over a real HTTP request through the scope middleware", async () => {
    const { companyId } = await seedCompanyWithPersonas(["@one", "@two"]);
    const app = createApp([companyId]);

    const res = await request(app).get(`/api/companies/${companyId}/personas`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((persona: { companyId: string }) => persona.companyId === companyId)).toBe(true);
  });

  it("creates a persona over a real HTTP request through the scope middleware", async () => {
    const { companyId, agentIds } = await seedCompanyWithPersonas([]);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Fresh Agent" });
    const app = createApp([companyId]);

    const res = await request(app)
      .post(`/api/agents/${agentId}/persona`)
      .send({ handle: "@fresh", status: "draft" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ companyId, agentId, handle: "@fresh" });

    const rows = await db.select().from(personas).where(eq(personas.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(agentIds).toHaveLength(0);
  });

  it("rejects a non-UUID companyId route param with 400 before ever reserving a connection", async () => {
    const app = createApp(["not-a-real-company"]);

    const res = await request(app).get("/api/companies/not-a-uuid/personas");

    expect(res.status).toBe(400);
  });

  it("never bleeds one company's session claim into the next request's response, across repeated pooled-connection reuse", async () => {
    const { companyId: companyA } = await seedCompanyWithPersonas(["@a-only"]);
    const { companyId: companyB } = await seedCompanyWithPersonas(["@b-only-1", "@b-only-2"]);
    const app = createApp([companyA, companyB]);

    // Sequential (not concurrent) so the released connection from each
    // request is the one most likely to be reused by the next -- this is
    // exactly the claim-bleed shape DUR-275's review was concerned about,
    // now proven over the real Express route instead of only the
    // packages/db-level primitive.
    for (let round = 0; round < 5; round++) {
      const resA = await request(app).get(`/api/companies/${companyA}/personas`);
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].handle).toBe("@a-only");

      const resB = await request(app).get(`/api/companies/${companyB}/personas`);
      expect(resB.status).toBe(200);
      expect(resB.body).toHaveLength(2);
      expect(resB.body.every((persona: { companyId: string }) => persona.companyId === companyB)).toBe(true);
    }
  });
});

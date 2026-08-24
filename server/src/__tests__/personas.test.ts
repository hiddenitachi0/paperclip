// DUR-133 (persona-mcp Ticket B, items 10-11): proves a persona is real
// identity attached to an agent, not just a DB row:
//   1. Creating a persona writes PERSONA.md into her managed instructions
//      bundle and adds a one-line pointer to it in AGENTS.md.
//   2. Editing her bio/voice re-renders PERSONA.md without touching any
//      other AGENTS.md content — a database-is-source-of-truth rewrite of
//      the whole entry file would destroy operator/agent edits.
//   3. The AGENTS.md pointer is added once, not duplicated on every save.
//   4. An agent can only ever have one persona.
//   5. Deleting a persona removes PERSONA.md but leaves the agent intact.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, personas } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createPersona,
  deletePersona,
  updatePersona,
} from "../services/personas.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres persona tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("personas — identity layered on an agent", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  let paperclipHome!: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("personas");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(personas);
    await db.delete(agents);
    await db.delete(companies);
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyAndAgent() {
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-personas-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maja",
      role: "general",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  function bundleRoot(companyId: string, agentId: string) {
    return path.join(paperclipHome, "instances", "test-instance", "companies", companyId, "agents", agentId, "instructions");
  }

  it("writes PERSONA.md and points AGENTS.md at it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();

    const persona = await createPersona(db, companyId, {
      agentId,
      displayName: "Maja",
      handle: "maja.jpg",
      bio: "24, photographer, grew up on the coast.",
      voice: "Warm, a little dry, short sentences.",
    });

    expect(persona.agentId).toBe(agentId);

    const root = bundleRoot(companyId, agentId);
    const personaMd = await fs.readFile(path.join(root, "PERSONA.md"), "utf8");
    expect(personaMd).toContain("# Maja");
    expect(personaMd).toContain("grew up on the coast");
    expect(personaMd).toContain("Warm, a little dry");

    const agentsMd = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("PERSONA.md");
  });

  it("re-renders PERSONA.md on edit and never duplicates the AGENTS.md pointer", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const persona = await createPersona(db, companyId, {
      agentId,
      displayName: "Maja",
      bio: "Version one.",
    });

    const root = bundleRoot(companyId, agentId);
    const agentsMdAfterCreate = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");

    await updatePersona(db, persona.id, { bio: "Version two." });

    const personaMd = await fs.readFile(path.join(root, "PERSONA.md"), "utf8");
    expect(personaMd).toContain("Version two.");
    expect(personaMd).not.toContain("Version one.");

    const agentsMdAfterUpdate = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agentsMdAfterUpdate).toBe(agentsMdAfterCreate);
    expect(agentsMdAfterUpdate.match(/PERSONA\.md/g)?.length).toBe(1);
  });

  it("preserves existing AGENTS.md content instead of overwriting it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const root = bundleRoot(companyId, agentId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Operator-written instructions\n\nDo not touch the schedule.\n", "utf8");

    await createPersona(db, companyId, { agentId, displayName: "Maja" });

    const agentsMd = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("Do not touch the schedule.");
    expect(agentsMd).toContain("PERSONA.md");
  });

  it("refuses a second persona on the same agent", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await createPersona(db, companyId, { agentId, displayName: "Maja" });
    await expect(createPersona(db, companyId, { agentId, displayName: "Maja again" })).rejects.toThrow();
  });

  it("deletes PERSONA.md but leaves the agent and her AGENTS.md intact", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const persona = await createPersona(db, companyId, { agentId, displayName: "Maja" });
    const root = bundleRoot(companyId, agentId);

    await deletePersona(db, persona.id);

    await expect(fs.readFile(path.join(root, "PERSONA.md"), "utf8")).rejects.toThrow();
    await expect(fs.readFile(path.join(root, "AGENTS.md"), "utf8")).resolves.toContain("PERSONA.md");

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agentRow).toBeTruthy();
  });
});

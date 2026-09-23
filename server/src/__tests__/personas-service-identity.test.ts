import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, personas } from "@paperclipai/db";
import { renderPersonaIdentity } from "@paperclipai/adapter-utils/server-utils";
import { personaService } from "../services/personas.js";
import { buildSystemPrompt } from "../services/lane-a.js";
import { resolveAgentForAdapter } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// DUR-4000 step 2: a persona is a PERSON in its own row; an agent is a JOB.
// Creating or editing a persona never renames or rewrites an agent, one
// persona can be attached to several agents, and each agent's prompt says
// "working as <its own name>".

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping persona service identity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("personaService (DUR-4000): a person, attached to jobs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-personas-identity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(personas);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, extra: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, role: "general", tone: "Plain.", personality: "The job's own text.", ...extra });
    return id;
  }

  it("creating a persona on an agent never renames or rewrites the agent; it only links the job to the person", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Sales agent 1");

    const created = await personaService(db).createPersona(agentId, {
      displayName: "Maja",
      pronouns: "she/her",
      traits: "curious",
      backstory: "Grew up by the sea.",
      voice: "Short and warm.",
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent).toMatchObject({
      name: "Sales agent 1",
      tone: "Plain.",
      personality: "The job's own text.",
      avatarAssetId: null,
      personaId: created.id,
    });
    expect(created).toMatchObject({ displayName: "Maja", pronouns: "she/her", agentIds: [agentId], agentId });
    const [persona] = await db.select().from(personas).where(eq(personas.id, created.id));
    expect(persona!.agentId).toBeNull();
  });

  it("updating a persona never touches the agent either", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Sales agent 1");
    const svc = personaService(db);
    const created = await svc.createPersona(agentId, { displayName: "Maja" });

    await svc.updatePersona(agentId, { displayName: "Maja Berg", voice: "Playful", backstory: "New story" });
    await svc.updatePersonaById(created.id, { pronouns: "they/them" });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent).toMatchObject({ name: "Sales agent 1", tone: "Plain.", personality: "The job's own text." });
    const view = await svc.getPersonaViewByAgentId(agentId);
    expect(view).toMatchObject({ displayName: "Maja Berg", voice: "Playful", backstory: "New story", bio: "New story", pronouns: "they/them" });
  });

  it("refuses a second persona on a job that already has one", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Sales agent 1");
    const svc = personaService(db);
    await svc.createPersona(agentId, { displayName: "Maja" });
    await expect(svc.createPersona(agentId, { displayName: "Someone else" })).rejects.toThrow("This agent already has a persona.");
  });

  it("one persona can hold several jobs, full and quick, and each job's prompt says 'working as' its own name", async () => {
    const companyId = await seedCompany();
    const svc = personaService(db);
    const maja = await svc.createPersonaForCompany(companyId, {
      displayName: "Maja",
      pronouns: "she/her",
      traits: "curious",
      backstory: "Grew up by the sea.",
      voice: "Short and warm.",
    });
    const salesId = await seedAgent(companyId, "Sales agent 1");
    const booksId = await seedAgent(companyId, "Accountant", { laneAEnabled: true });

    await svc.attachPersonaToAgent(salesId, maja.id);
    await svc.attachPersonaToAgent(booksId, maja.id);

    expect((await svc.listAgentsForPersona(maja.id)).map((a) => [a.name, a.laneAEnabled])).toEqual([
      ["Accountant", true],
      ["Sales agent 1", false],
    ]);
    expect((await svc.getPersonaById(maja.id))!.agentIds.sort()).toEqual([salesId, booksId].sort());

    // Full agent (heartbeat -> adapter): the persona's voice wins over the
    // agent's tone and the identity block replaces the agent's personality.
    const [sales] = await db.select().from(agents).where(eq(agents.id, salesId));
    const salesIdentity = await svc.getPromptIdentityByAgentId(salesId);
    const salesForAdapter = resolveAgentForAdapter(sales!, salesIdentity);
    expect(salesForAdapter.name).toBe("Sales agent 1");
    expect(salesForAdapter.tone).toBe("Short and warm.");
    expect(salesForAdapter.personality).toBe(
      "You are Maja (she/her), working as Sales agent 1.\n\nTraits: curious\n\nBackstory: Grew up by the sea.",
    );
    expect(salesForAdapter.personality).not.toContain("The job's own text.");

    // Quick agent (Lane A): the same person, a different job name.
    const booksIdentity = await svc.getPromptIdentityByAgentId(booksId);
    const prompt = buildSystemPrompt({ agentName: "Accountant", hasMcpTools: false, hasBuiltinTools: false, persona: booksIdentity });
    expect(prompt).toContain("You are Maja (she/her), working as Accountant, a quick agent in Paperclip.");
    expect(prompt).not.toContain("Sales agent 1");

    // The display rule for lists: "job (person)".
    expect(await svc.getPersonaDisplayNamesByAgentIds([salesId, booksId, randomUUID()])).toEqual(
      new Map([
        [salesId, "Maja"],
        [booksId, "Maja"],
      ]),
    );
  });

  it("an agent with no persona keeps its own tone and personality, and gets no identity block", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Blank job");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(await personaService(db).getPromptIdentityByAgentId(agentId)).toBeNull();
    expect(resolveAgentForAdapter(agent!, null)).toBe(agent);
    expect(renderPersonaIdentity({ displayName: null }, agent!)).toBeNull();
  });

  it("a persona with a voice wins over the agent's tone; without one the agent's tone stays", async () => {
    const agent = { name: "Sales agent 1", tone: "Plain.", personality: "Old text" };
    expect(resolveAgentForAdapter(agent, { displayName: "Maja", voice: "  " }).tone).toBe("Plain.");
    expect(resolveAgentForAdapter(agent, { displayName: "Maja", voice: "Warm" }).tone).toBe("Warm");
    expect(resolveAgentForAdapter(agent, { displayName: "Maja" }).personality).toBe("You are Maja, working as Sales agent 1.");
  });

  it("detaching or deleting the person leaves the job in place", async () => {
    const companyId = await seedCompany();
    const svc = personaService(db);
    const agentId = await seedAgent(companyId, "Sales agent 1");
    const created = await svc.createPersona(agentId, { displayName: "Maja" });

    expect(await svc.attachPersonaToAgent(agentId, null)).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.personaId).toBeNull();

    await svc.attachPersonaToAgent(agentId, created.id);
    await svc.deletePersonaById(created.id);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent).toMatchObject({ name: "Sales agent 1", personaId: null });
  });

  it("refuses to attach a persona from another company", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const svc = personaService(db);
    const other = await svc.createPersonaForCompany(companyB, { displayName: "Not yours" });
    const agentId = await seedAgent(companyA, "Sales agent 1");
    await expect(svc.attachPersonaToAgent(agentId, other.id)).rejects.toThrow("That persona does not exist in this company.");
  });
});

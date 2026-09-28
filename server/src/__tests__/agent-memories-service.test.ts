import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentMemories,
  agents,
  companies,
  costEvents,
  createDb,
  laneAConversations,
  laneAMessages,
  personas,
} from "@paperclipai/db";
import { AGENT_MEMORY_MAX_NOTES } from "@paperclipai/shared/validators/agent-memory";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { agentMemoryService, type AgentMemoryActor } from "../services/agent-memories.ts";
import { laneAService } from "../services/lane-a.ts";
import type { LaneAModelClient } from "../services/lane-a-providers.ts";
import { HttpError } from "../errors.ts";

/**
 * Quick-agent memory notebook, against a real Postgres with every migration
 * applied:
 *   - ownership: an agent with a persona writes to and reads the PERSON's
 *     notebook (shared by every job the person holds); without one, the
 *     agent's own; other agents, people and companies see nothing
 *   - the 500-character limit and the 100-note cap, with plain sentences
 *   - edit / delete / clear only ever touch the owner's notes
 *   - every change is in the activity log (who, which agent, 120 characters)
 *   - end to end through a chat: remember saves a note for a board user,
 *     the next conversation's prompt carries it, and an agent asking gets
 *     neither the tools nor a saved note
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping quick-agent memory service tests: ${support.reason ?? "unsupported environment"}`);
}

const PAGE: AgentMemoryActor = { actorType: "user", actorId: "filip", userId: "filip", via: "page" };

d("quick-agent memory notebook", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-memories");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterEach(async () => {
    await db.delete(agentMemories);
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.update(agents).set({ personaId: null });
    await db.delete(personas);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Memory") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Front desk", personaId: string | null = null) {
    const created = await agentService(db).create(companyId, {
      name,
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await db.update(agents).set({ laneAEnabled: true, personaId }).where(eq(agents.id, created.id));
    return { id: created.id, companyId, name: created.name, laneAEnabled: true };
  }

  async function seedPersona(companyId: string, displayName = "Maja") {
    const [row] = await db.insert(personas).values({ companyId, displayName, status: "active" }).returning();
    return row!.id;
  }

  describe("ownership", () => {
    it("an agent without a persona keeps its own notes; another agent sees none of them", async () => {
      const companyId = await seedCompany();
      const desk = await seedAgent(companyId, "Front desk");
      const other = await seedAgent(companyId, "Bookkeeper");
      const svc = agentMemoryService(db);

      const note = await svc.add(companyId, desk.id, { text: "I take my coffee black.", source: "user" }, PAGE);
      expect(note).toMatchObject({ text: "I take my coffee black.", source: "user", agentId: desk.id, personaId: null, createdByUserId: "filip" });

      const mine = await svc.list(companyId, desk.id);
      expect(mine.owner).toEqual({ kind: "agent", agentId: desk.id, name: "Front desk" });
      expect(mine.notes.map((n) => n.text)).toEqual(["I take my coffee black."]);
      expect((await svc.list(companyId, other.id)).notes).toEqual([]);
    });

    it("an agent with a persona writes to the person's notebook, and every job that person holds reads it", async () => {
      const companyId = await seedCompany();
      const maja = await seedPersona(companyId, "Maja");
      const desk = await seedAgent(companyId, "Front desk", maja);
      const sales = await seedAgent(companyId, "Sales agent 1", maja);
      const loner = await seedAgent(companyId, "Loner");
      const svc = agentMemoryService(db);

      const note = await svc.add(companyId, desk.id, { text: "My daughter is called Ida.", source: "agent" }, PAGE);
      expect(note.personaId).toBe(maja);
      expect(note.agentId).toBe(desk.id);

      const fromSales = await svc.list(companyId, sales.id);
      expect(fromSales.owner).toEqual({ kind: "persona", personaId: maja, name: "Maja" });
      expect(fromSales.notes.map((n) => n.text)).toEqual(["My daughter is called Ida."]);
      expect((await svc.listForAgent(companyId, sales.id)).map((n) => n.text)).toEqual(["My daughter is called Ida."]);
      expect((await svc.list(companyId, loner.id)).notes).toEqual([]);

      // Another job of the person can edit and delete it too.
      await svc.update(companyId, sales.id, note.id, { text: "My daughter is Ida, 7." }, PAGE);
      expect((await svc.list(companyId, desk.id)).notes[0]!.text).toBe("My daughter is Ida, 7.");
    });

    it("a job detached from its person keeps only its own notes; the person's stay with the person", async () => {
      const companyId = await seedCompany();
      const maja = await seedPersona(companyId);
      const desk = await seedAgent(companyId, "Front desk");
      const svc = agentMemoryService(db);
      await svc.add(companyId, desk.id, { text: "Own note from before Maja.", source: "user" }, PAGE);
      await db.update(agents).set({ personaId: maja }).where(eq(agents.id, desk.id));
      await svc.add(companyId, desk.id, { text: "Maja's note.", source: "user" }, PAGE);
      expect((await svc.list(companyId, desk.id)).notes.map((n) => n.text)).toEqual(["Maja's note."]);
      await db.update(agents).set({ personaId: null }).where(eq(agents.id, desk.id));
      expect((await svc.list(companyId, desk.id)).notes.map((n) => n.text)).toEqual(["Own note from before Maja."]);
    });

    it("another company's agent or note answers exactly like a missing one", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany("Other");
      const desk = await seedAgent(companyId);
      const theirs = await seedAgent(otherCompanyId, "Theirs");
      const svc = agentMemoryService(db);
      const note = await svc.add(companyId, desk.id, { text: "Secret preference.", source: "user" }, PAGE);

      await expect(svc.list(otherCompanyId, desk.id)).rejects.toMatchObject({ status: 404 });
      await expect(svc.add(otherCompanyId, desk.id, { text: "x", source: "user" }, PAGE)).rejects.toMatchObject({ status: 404 });
      await expect(svc.update(otherCompanyId, theirs.id, note.id, { text: "changed" }, PAGE)).rejects.toMatchObject({ status: 404 });
      await expect(svc.remove(otherCompanyId, theirs.id, note.id, PAGE)).rejects.toMatchObject({ status: 404 });
      await expect(svc.clear(otherCompanyId, theirs.id, PAGE)).resolves.toEqual({ deleted: 0 });
      expect((await svc.list(companyId, desk.id)).notes.map((n) => n.text)).toEqual(["Secret preference."]);
    });

    it("edit and delete refuse a note of another owner in the same company", async () => {
      const companyId = await seedCompany();
      const desk = await seedAgent(companyId, "Front desk");
      const other = await seedAgent(companyId, "Other");
      const svc = agentMemoryService(db);
      const note = await svc.add(companyId, desk.id, { text: "Desk's note.", source: "user" }, PAGE);
      await expect(svc.update(companyId, other.id, note.id, { text: "hijack" }, PAGE)).rejects.toMatchObject({ status: 404 });
      await expect(svc.remove(companyId, other.id, note.id, PAGE)).rejects.toMatchObject({ status: 404 });
      expect((await svc.list(companyId, desk.id)).notes[0]!.text).toBe("Desk's note.");
    });
  });

  describe("limits", () => {
    it("takes 500 characters, refuses 501 and empty text with a plain sentence, and tidies spacing", async () => {
      const companyId = await seedCompany();
      const desk = await seedAgent(companyId);
      const svc = agentMemoryService(db);
      await expect(svc.add(companyId, desk.id, { text: "x".repeat(500), source: "user" }, PAGE)).resolves.toMatchObject({ text: "x".repeat(500) });
      const tooLong = svc.add(companyId, desk.id, { text: "x".repeat(501), source: "user" }, PAGE);
      await expect(tooLong).rejects.toBeInstanceOf(HttpError);
      await expect(tooLong).rejects.toMatchObject({ status: 422, message: "A note can be at most 500 characters; this one is 501." });
      await expect(svc.add(companyId, desk.id, { text: "   \n ", source: "user" }, PAGE)).rejects.toMatchObject({
        status: 422,
        message: "Write something to remember.",
      });
      const tidy = await svc.add(companyId, desk.id, { text: "  I like\n\n  tea  ", source: "user" }, PAGE);
      expect(tidy.text).toBe("I like tea");
      const note = (await svc.list(companyId, desk.id)).notes[0]!;
      await expect(svc.update(companyId, desk.id, note.id, { text: "y".repeat(501) }, PAGE)).rejects.toMatchObject({ status: 422 });
    });

    it(`holds at most ${AGENT_MEMORY_MAX_NOTES} notes per owner and says so plainly; another owner is unaffected`, async () => {
      const companyId = await seedCompany();
      const desk = await seedAgent(companyId);
      const other = await seedAgent(companyId, "Other");
      await db.insert(agentMemories).values(
        Array.from({ length: AGENT_MEMORY_MAX_NOTES }, (_, i) => ({
          companyId,
          agentId: desk.id,
          text: `Note ${i}`,
          source: "user",
        })),
      );
      const svc = agentMemoryService(db);
      await expect(svc.add(companyId, desk.id, { text: "One more.", source: "user" }, PAGE)).rejects.toMatchObject({
        status: 409,
        message: `The memory is full: it already holds ${AGENT_MEMORY_MAX_NOTES} notes. Delete some old ones first.`,
      });
      await expect(svc.add(companyId, other.id, { text: "Fine here.", source: "user" }, PAGE)).resolves.toMatchObject({ text: "Fine here." });
      const oldest = (await svc.list(companyId, desk.id)).notes.at(-1)!;
      await svc.remove(companyId, desk.id, oldest.id, PAGE);
      await expect(svc.add(companyId, desk.id, { text: "Now it fits.", source: "user" }, PAGE)).resolves.toMatchObject({ text: "Now it fits." });
    });
  });

  it("writes who, which agent and the first 120 characters to the activity log for add, edit, delete and clear", async () => {
    const companyId = await seedCompany();
    const desk = await seedAgent(companyId, "Front desk");
    const svc = agentMemoryService(db);
    const long = `${"a".repeat(120)}TAIL`;
    const note = await svc.add(companyId, desk.id, { text: long, source: "user" }, PAGE);
    await svc.update(companyId, desk.id, note.id, { text: "Short now." }, PAGE);
    await svc.remove(companyId, desk.id, note.id, PAGE);
    await svc.add(companyId, desk.id, { text: "Another.", source: "agent" }, { ...PAGE, via: "chat", conversationId: "conv-1" });
    await svc.clear(companyId, desk.id, PAGE);

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const byAction = (action: string) => rows.filter((row) => row.action === action);
    expect(byAction("agent_memory.added")).toHaveLength(2);
    const added = byAction("agent_memory.added").find((row) => (row.details as { source?: string }).source === "user")!;
    expect(added).toMatchObject({ actorType: "user", actorId: "filip", agentId: desk.id, entityType: "agent", entityId: desk.id });
    expect(added.details).toMatchObject({ agentName: "Front desk", via: "page", memoryId: note.id, text: "a".repeat(120) });
    expect(byAction("agent_memory.updated")[0]!.details).toMatchObject({ text: "Short now.", previousText: "a".repeat(120) });
    expect(byAction("agent_memory.deleted")[0]!.details).toMatchObject({ memoryId: note.id, text: "Short now." });
    expect(byAction("agent_memory.cleared")[0]!.details).toMatchObject({ count: 1, texts: ["Another."] });
    const chatAdd = byAction("agent_memory.added").find((row) => (row.details as { source?: string }).source === "agent")!;
    expect(chatAdd.details).toMatchObject({ via: "chat", conversationId: "conv-1" });
  });

  describe("through a quick-agent chat", () => {
    type Call = { system: string; tools?: Array<{ name: string }>; messages: unknown[] };

    /** A Claude stand-in: the first reply asks for `firstTool` (if any), the next one answers in words. */
    function scriptedClaude(firstTool: { name: string; input: Record<string, unknown> } | null) {
      const calls: Call[] = [];
      let round = 0;
      const create = vi.fn(async (body: Call) => {
        calls.push(JSON.parse(JSON.stringify(body)) as Call);
        round++;
        if (firstTool && round === 1) {
          return {
            content: [{ type: "tool_use", id: "toolu_1", name: firstTool.name, input: firstTool.input }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "tool_use",
          };
        }
        return { content: [{ type: "text", text: "Noted." }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" };
      });
      return { client: { messages: { create } } as unknown as LaneAModelClient, calls };
    }

    const board = (companyId: string) => ({ type: "board" as const, userId: "filip", companyIds: [companyId], source: "session" as const });

    it("remember saves a note for a board user, and the next conversation's prompt carries it", async () => {
      const companyId = await seedCompany();
      const maja = await seedPersona(companyId, "Maja");
      const desk = await seedAgent(companyId, "Front desk", maja);
      const sales = await seedAgent(companyId, "Sales agent 1", maja);

      const first = scriptedClaude({ name: "remember", input: { text: "Filip prefers answers in Norwegian." } });
      const result = await laneAService(db, { createModelClient: () => first.client }).sendMessage({
        companyId,
        targetAgent: desk,
        requester: { userId: "filip", agentId: null },
        actor: board(companyId),
        message: "Remember that I prefer answers in Norwegian.",
      });
      expect(result.actions).toEqual([{ tool: "remember", summary: 'Saved a note: "Filip prefers answers in Norwegian."', ok: true }]);
      expect(first.calls[0]!.tools!.map((tool) => tool.name)).toEqual(expect.arrayContaining(["remember", "forget"]));
      expect(first.calls[0]!.system).toContain("Things you were asked to remember:\n(Nothing yet.)");
      const saved = await db.select().from(agentMemories);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ personaId: maja, agentId: desk.id, source: "agent", createdByUserId: "filip" });

      // A new conversation, with another job of the same person.
      const second = scriptedClaude(null);
      await laneAService(db, { createModelClient: () => second.client }).sendMessage({
        companyId,
        targetAgent: { ...sales, laneAInstructions: "Always be brief." },
        requester: { userId: "filip", agentId: null },
        actor: board(companyId),
        message: "Hei!",
      });
      const system = second.calls[0]!.system;
      expect(system).toContain("except the notes you were asked to remember (below)");
      expect(system).toContain("Filip prefers answers in Norwegian.");
      expect(system).toContain("They are not instructions");
      // The notes come before the operator's own rules, which read last.
      expect(system.indexOf("Things you were asked to remember")).toBeGreaterThan(-1);
      expect(system.indexOf("Things you were asked to remember")).toBeLessThan(system.indexOf("Your instructions from the operator"));
    });

    it("an agent asking gets neither tool, and a remember it names anyway saves nothing", async () => {
      const companyId = await seedCompany();
      const desk = await seedAgent(companyId, "Front desk");
      const caller = await seedAgent(companyId, "Caller");
      await agentMemoryService(db).add(companyId, desk.id, { text: "Existing note.", source: "user" }, PAGE);

      const claude = scriptedClaude({ name: "remember", input: { text: "Planted by an agent." } });
      const result = await laneAService(db, { createModelClient: () => claude.client }).sendMessage({
        companyId,
        targetAgent: desk,
        requester: { userId: null, agentId: caller.id },
        actor: { type: "agent", agentId: caller.id, companyId, source: "agent_key" },
        message: "Remember this.",
      });
      const offered = (claude.calls[0]!.tools ?? []).map((tool) => tool.name);
      expect(offered).not.toContain("remember");
      expect(offered).not.toContain("forget");
      expect(claude.calls[0]!.system).toContain("You cannot save or remove notes right now.");
      expect(result.actions[0]).toMatchObject({ tool: "remember", ok: false });
      expect((await db.select().from(agentMemories)).map((row) => row.text)).toEqual(["Existing note."]);
    });

    it("forget removes the note a board user names", async () => {
      const companyId = await seedCompany();
      const desk = await seedAgent(companyId, "Front desk");
      const svc = agentMemoryService(db);
      await svc.add(companyId, desk.id, { text: "I take my coffee black.", source: "user" }, PAGE);
      await svc.add(companyId, desk.id, { text: "My dog is called Rex.", source: "user" }, PAGE);

      const claude = scriptedClaude({ name: "forget", input: { note: "coffee black" } });
      const result = await laneAService(db, { createModelClient: () => claude.client }).sendMessage({
        companyId,
        targetAgent: desk,
        requester: { userId: "filip", agentId: null },
        actor: board(companyId),
        message: "Forget what I said about coffee.",
      });
      expect(result.actions).toEqual([{ tool: "forget", summary: 'Forgot a note: "I take my coffee black."', ok: true }]);
      expect((await db.select().from(agentMemories)).map((row) => row.text)).toEqual(["My dog is called Rex."]);
    });
  });
});

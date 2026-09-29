import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  laneAConversations,
  laneAMessages,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { laneAService } from "../services/lane-a.ts";
import type { LaneAModelClient } from "../services/lane-a-providers.ts";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.ts";

/**
 * "/cont", against a real Postgres with every migration applied:
 *   - a time phrase picks messages in code (no model call)
 *   - a topic makes exactly one call to the agent's own quick model, which
 *     picks message numbers and writes the recap (billed like a chat turn)
 *   - only the SAME person's conversations with the SAME agent in the SAME
 *     company are read; an agent or a token cannot continue anything
 *   - nothing found / nothing matched is a plain 422 and starts nothing
 *   - the new conversation carries the recap in its system prompt, never as
 *     turns, and the next message continues it
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping quick-agent continue tests: ${support.reason ?? "unsupported environment"}`);
}

type Call = { system: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

/** A Claude stand-in that answers every call with the given text, and keeps what it was sent. */
function fakeClaude(answer: string) {
  const calls: Call[] = [];
  const create = vi.fn(async (body: Call) => {
    calls.push(JSON.parse(JSON.stringify(body)) as Call);
    return { content: [{ type: "text", text: answer }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "end_turn" };
  });
  return { client: { messages: { create } } as unknown as LaneAModelClient, calls, create };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

d("continue an earlier quick-agent conversation", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("lane-a-continue");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  // "Today" and "yesterday" are Oslo calendar days, and the seeded messages are
  // "N minutes ago": run every test at an Oslo midday so a CI run just after
  // midnight never pushes a message onto the previous day. The fake clock is
  // the latest Oslo midday that is not in the future, so rows the database
  // stamps with its own (real) clock are never older than the fake "now" and
  // never trip the idle timeout. Only Date is faked; real timers keep the
  // database and the service's awaits working.
  beforeEach(() => {
    const realNow = Date.now();
    const osloDay = new Date(realNow).toLocaleDateString("en-CA", { timeZone: "Europe/Oslo" });
    let midday = new Date(`${osloDay}T10:00:00Z`).getTime();
    if (midday > realNow) midday -= 24 * 60 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(midday));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(laneAMessages);
    await db.delete(laneAConversations);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(name = "Continue") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Maja") {
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
    await db.update(agents).set({ laneAEnabled: true }).where(eq(agents.id, created.id));
    return { id: created.id, companyId, name: created.name, laneAEnabled: true };
  }

  /** One stored conversation: [role, text, minutes ago] per message. */
  async function seedConversation(
    companyId: string,
    agentId: string,
    requester: { userId?: string; agentId?: string },
    turns: Array<["user" | "assistant", string, number]>,
  ) {
    const last = Math.min(...turns.map((turn) => turn[2]));
    const [conversation] = await db
      .insert(laneAConversations)
      .values({
        companyId,
        agentId,
        requestedByUserId: requester.userId ?? null,
        requestedByAgentId: requester.agentId ?? null,
        turnCount: Math.ceil(turns.length / 2),
        lastMessageAt: minutesAgo(last),
        createdAt: minutesAgo(Math.max(...turns.map((turn) => turn[2]))),
      })
      .returning();
    await db.insert(laneAMessages).values(
      turns.map(([role, content, ago]) => ({
        companyId,
        conversationId: conversation!.id,
        agentId,
        role,
        content,
        createdAt: minutesAgo(ago),
      })),
    );
    return conversation!.id;
  }

  const board = (companyId: string, userId = "filip") => ({
    type: "board" as const,
    userId,
    companyIds: [companyId],
    source: "session" as const,
  });
  const filip = { userId: "filip", agentId: null };

  async function recapRowOf(conversationId: string) {
    const rows = await db.select().from(laneAMessages).where(eq(laneAMessages.conversationId, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("recap");
    return rows[0]!;
  }

  it("a time phrase picks the messages in that window in code, with no model call", async () => {
    const companyId = await seedCompany();
    const maja = await seedAgent(companyId);
    await seedConversation(companyId, maja.id, { userId: "filip" }, [
      ["user", "Old: what is the VAT rate?", 120],
      ["assistant", "Old: 25 percent.", 119],
    ]);
    await seedConversation(companyId, maja.id, { userId: "filip" }, [
      ["user", "Draft the newsletter intro about autumn chairs.", 20],
      ["assistant", "Here is a draft: Autumn is here…", 19],
    ]);
    const claude = fakeClaude("unused");

    const result = await laneAService(db, { createModelClient: () => claude.client }).continueConversation({
      companyId,
      targetAgent: maja,
      requester: filip,
      actor: board(companyId),
      spec: "last 45 minutes",
    });

    expect(claude.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "time", matchedMessages: 2, consideredMessages: 2, fromConversations: 1 });
    expect(result.recap).toContain("the last 45 minutes (2 messages");
    expect(result.recap).toContain('Last thing you said: "Draft the newsletter intro about autumn chairs."');

    const [conversation] = await db.select().from(laneAConversations).where(eq(laneAConversations.id, result.conversationId));
    expect(conversation).toMatchObject({ requestedByUserId: "filip", requestedByAgentId: null, agentId: maja.id, turnCount: 0 });
    const recap = await recapRowOf(result.conversationId);
    expect(recap.content).toContain("Person: Draft the newsletter intro about autumn chairs.");
    expect(recap.content).toContain("You (Maja): Here is a draft: Autumn is here…");
    expect(recap.content).not.toContain("VAT");
    expect((await db.select().from(costEvents)).length).toBe(0);
    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, "lane_a.conversation_continued"));
    expect(logged?.details).toMatchObject({ mode: "time", matchedMessages: 2 });
  });

  it("reads only this person's conversations with this agent in this company", async () => {
    const companyId = await seedCompany();
    const otherCompany = await seedCompany("Other");
    const maja = await seedAgent(companyId);
    const bob = await seedAgent(companyId, "Bob");
    const majaElsewhere = await seedAgent(otherCompany, "Maja");
    await seedConversation(companyId, maja.id, { userId: "filip" }, [["user", "Mine with Maja.", 10]]);
    await seedConversation(companyId, maja.id, { userId: "someone-else" }, [["user", "SECRET of another person.", 5]]);
    await seedConversation(companyId, maja.id, { agentId: bob.id }, [["user", "An agent asked Maja this.", 4]]);
    await seedConversation(companyId, bob.id, { userId: "filip" }, [["user", "Mine with Bob.", 3]]);
    await seedConversation(otherCompany, majaElsewhere.id, { userId: "filip" }, [["user", "Mine in another company.", 2]]);

    const svc = laneAService(db, { createModelClient: () => fakeClaude("unused").client });
    for (const spec of ["", "today"]) {
      const result = await svc.continueConversation({
        companyId,
        targetAgent: maja,
        requester: filip,
        actor: board(companyId),
        spec,
      });
      expect(result.matchedMessages, spec).toBe(1);
      const seed = (await recapRowOf(result.conversationId)).content;
      expect(seed).toContain("Mine with Maja.");
      for (const foreign of ["SECRET", "An agent asked", "Mine with Bob", "another company"]) {
        expect(seed, `${spec}: ${foreign}`).not.toContain(foreign);
      }
    }
  });

  it("an agent, a delegate or a service token cannot continue anything", async () => {
    const companyId = await seedCompany();
    const maja = await seedAgent(companyId);
    const bob = await seedAgent(companyId, "Bob");
    await seedConversation(companyId, maja.id, { agentId: bob.id }, [["user", "Bob's chat.", 5]]);
    const svc = laneAService(db);
    const refusals = [
      { requester: { userId: null, agentId: bob.id }, actor: { type: "agent" as const, agentId: bob.id, companyId } },
      { requester: filip, actor: { type: "board_delegate" as const, userId: "filip", companyIds: [companyId] } },
      { requester: { userId: null, agentId: null }, actor: { type: "service" as const, companyId } },
      { requester: filip, actor: undefined },
    ];
    for (const refusal of refusals) {
      await expect(
        svc.continueConversation({ companyId, targetAgent: maja, ...refusal, spec: "" }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(await db.select().from(laneAConversations)).toHaveLength(1);
  });

  it("a topic makes one call to the agent's own model, which picks the messages and writes the recap", async () => {
    const companyId = await seedCompany();
    const maja = await seedAgent(companyId);
    await seedConversation(companyId, maja.id, { userId: "filip" }, [
      ["user", "Let's prepare the meeting with Jacsped.", 90],
      ["assistant", "Agenda: delivery times, prices.", 89],
      ["user", "What's the weather in Oslo?", 60],
      ["assistant", "Sunny, 14 degrees.", 59],
    ]);
    const claude = fakeClaude('{"ids": [1, 2], "recap": "Preparing the Jacsped meeting: agenda is delivery times and prices."}');

    const result = await laneAService(db, { createModelClient: () => claude.client }).continueConversation({
      companyId,
      targetAgent: maja,
      requester: filip,
      actor: board(companyId),
      spec: "our meeting today",
    });

    expect(claude.create).toHaveBeenCalledTimes(1);
    const call = claude.calls[0]!;
    expect(call.tools).toBeUndefined();
    expect(call.system).toContain('Answer with JSON only');
    expect(String(call.messages[0]!.content)).toContain('The person wants to continue: "our meeting today"');
    expect(String(call.messages[0]!.content)).toMatch(/\[1\] .* Person: Let's prepare the meeting with Jacsped\./);
    expect(String(call.messages[0]!.content)).toMatch(/\[4\] .* Maja: Sunny, 14 degrees\./);

    expect(result).toMatchObject({
      mode: "topic",
      matchedMessages: 2,
      consideredMessages: 4,
      recap: "Preparing the Jacsped meeting: agenda is delivery times and prices.",
    });
    const seed = (await recapRowOf(result.conversationId)).content;
    expect(seed).toContain("Summary: Preparing the Jacsped meeting");
    expect(seed).toContain("Agenda: delivery times, prices.");
    expect(seed).not.toContain("weather");
    const costs = await db.select().from(costEvents);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ agentId: maja.id, inputTokens: 100, outputTokens: 20 });
  });

  it("nothing found or nothing matched is a plain refusal that starts nothing", async () => {
    const companyId = await seedCompany();
    const maja = await seedAgent(companyId);
    const none = fakeClaude("unused");
    const svc = laneAService(db, { createModelClient: () => none.client });
    await expect(
      svc.continueConversation({ companyId, targetAgent: maja, requester: filip, actor: board(companyId), spec: "" }),
    ).rejects.toMatchObject({ status: 422, details: { code: "LANE_A_CONTINUE_NOTHING_FOUND" } });

    await seedConversation(companyId, maja.id, { userId: "filip" }, [["user", "Something from two hours ago.", 120]]);
    await expect(
      svc.continueConversation({ companyId, targetAgent: maja, requester: filip, actor: board(companyId), spec: "last 30 minutes" }),
    ).rejects.toMatchObject({
      status: 422,
      message: "I found no messages with Maja from the last 30 minutes, so there is nothing to continue.",
    });
    expect(none.create).not.toHaveBeenCalled();

    const noMatch = fakeClaude('{"ids": [], "recap": ""}');
    await expect(
      laneAService(db, { createModelClient: () => noMatch.client }).continueConversation({
        companyId,
        targetAgent: maja,
        requester: filip,
        actor: board(companyId),
        spec: "the budget",
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "LANE_A_CONTINUE_NO_MATCH" } });
    expect(noMatch.create).toHaveBeenCalledTimes(1);
    // Only the seeded conversation: no new one was started.
    expect(await db.select().from(laneAConversations)).toHaveLength(1);
  });

  it("the new conversation carries the recap in its system prompt, not as turns, and the next message continues it", async () => {
    const companyId = await seedCompany();
    const maja = await seedAgent(companyId);
    await seedConversation(companyId, maja.id, { userId: "filip" }, [
      ["user", "Let's name the new sofa line.", 40],
      ["assistant", "How about 'Fjord'?", 39],
    ]);
    const claude = fakeClaude("Fjord Lounge could work too.");
    const svc = laneAService(db, { createModelClient: () => claude.client });

    const continued = await svc.continueConversation({
      companyId,
      targetAgent: maja,
      requester: filip,
      actor: board(companyId),
      spec: "last conversation",
    });
    expect(continued.mode).toBe("last");

    const reply = await svc.sendMessage({
      companyId,
      targetAgent: { ...maja, laneAInstructions: "Always be brief." },
      requester: filip,
      actor: board(companyId),
      message: "Any other ideas?",
      conversationId: continued.conversationId,
    });
    expect(reply.conversationId).toBe(continued.conversationId);
    const call = claude.calls[0]!;
    expect(call.system).toContain("Earlier conversation, recapped for continuity:");
    expect(call.system).toContain("Person: Let's name the new sofa line.");
    expect(call.system).toContain("You (Maja): How about 'Fjord'?");
    expect(call.system.indexOf("Earlier conversation, recapped")).toBeLessThan(call.system.indexOf("Your instructions from the operator"));
    // The earlier chat is not replayed as made-up turns: only the new message.
    expect(call.messages).toEqual([{ role: "user", content: "Any other ideas?" }]);

    const transcript = await svc.getConversation({
      companyId,
      targetAgentId: maja.id,
      conversationId: continued.conversationId,
      requester: filip,
    });
    expect(transcript.continuedFrom).toBe(continued.recap);
    expect(transcript.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    // A second message in the same continued conversation still carries it.
    await svc.sendMessage({
      companyId,
      targetAgent: maja,
      requester: filip,
      actor: board(companyId),
      message: "And a cheaper one?",
      conversationId: continued.conversationId,
    });
    expect(claude.calls[1]!.system).toContain("Person: Let's name the new sofa line.");
    expect(claude.calls[1]!.messages).toHaveLength(3);

    // Continuing the continued conversation carries the earlier recap along.
    const again = await svc.continueConversation({ companyId, targetAgent: maja, requester: filip, actor: board(companyId) });
    const seed = (await recapRowOf(again.conversationId)).content;
    expect(seed).toContain("That conversation itself continued an earlier one:");
    expect(seed).toContain("Let's name the new sofa line.");
    expect(seed).toContain("Person: And a cheaper one?");
  });

  it("the last conversation is only the most recent one", async () => {
    const companyId = await seedCompany();
    const maja = await seedAgent(companyId);
    await seedConversation(companyId, maja.id, { userId: "filip" }, [["user", "Older conversation.", 300]]);
    await seedConversation(companyId, maja.id, { userId: "filip" }, [
      ["user", "Newest conversation.", 50],
      ["assistant", "Reply in the newest.", 49],
    ]);
    const result = await laneAService(db).continueConversation({
      companyId,
      targetAgent: maja,
      requester: filip,
      actor: board(companyId),
      spec: "",
    });
    expect(result).toMatchObject({ mode: "last", matchedMessages: 2 });
    const seed = (await recapRowOf(result.conversationId)).content;
    expect(seed).toContain("Newest conversation.");
    expect(seed).not.toContain("Older conversation.");
  });

  describe("/looks", () => {
    const LOOKS_TOOL = "paperclip.media-studio:list-looks";

    function fakeDispatcher() {
      const executeTool = vi.fn(async () => ({
        pluginId: "paperclip.media-studio",
        toolName: "list-looks",
        result: { content: "Saved looks:\n- Nordic calm" },
      }));
      const dispatcher = {
        getTool: (name: string) =>
          name === LOOKS_TOOL
            ? { pluginId: "paperclip.media-studio", pluginDbId: randomUUID(), name: "list-looks", namespacedName: LOOKS_TOOL }
            : null,
        executeTool,
        listToolsForAgent: () => [],
      } as unknown as PluginToolDispatcher;
      return { dispatcher, executeTool };
    }

    it("runs the ticked list-looks tool as the quick agent, with no model call", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      await db.update(agents).set({ pluginToolGrants: [LOOKS_TOOL] }).where(eq(agents.id, maja.id));
      const { dispatcher, executeTool } = fakeDispatcher();
      const claude = fakeClaude("unused");

      const result = await laneAService(db, {
        pluginToolDispatcher: dispatcher,
        createModelClient: () => claude.client,
      }).listLooks({ companyId, targetAgent: maja, requester: filip, actor: board(companyId) });

      expect(result).toEqual({ available: true, text: "Saved looks:\n- Nordic calm" });
      expect(executeTool).toHaveBeenCalledWith(LOOKS_TOOL, {}, expect.objectContaining({ agentId: maja.id, companyId }));
      expect(claude.create).not.toHaveBeenCalled();
    });

    it("says so plainly when the tool is not ticked, and refuses anyone but a board user", async () => {
      const companyId = await seedCompany();
      const maja = await seedAgent(companyId);
      const { dispatcher, executeTool } = fakeDispatcher();
      const svc = laneAService(db, { pluginToolDispatcher: dispatcher });
      await expect(svc.listLooks({ companyId, targetAgent: maja, requester: filip, actor: board(companyId) })).resolves.toEqual({
        available: false,
        text: 'Maja cannot list saved looks: the "List saved looks" add-on tool is not ticked for it.',
      });
      await expect(
        svc.listLooks({
          companyId,
          targetAgent: maja,
          requester: { userId: null, agentId: maja.id },
          actor: { type: "agent", agentId: maja.id, companyId },
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(executeTool).not.toHaveBeenCalled();
    });
  });
});

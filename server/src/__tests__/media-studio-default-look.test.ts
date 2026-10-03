import { describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin, { lookMentionedIn, type Look } from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE, TOOL_LIST_LOOKS } from "../../../packages/plugins/media-studio/src/manifest.js";

/**
 * Media Studio's default look per agent: an owner/admin gives an agent a
 * saved look that is used for every picture it makes without naming one.
 * Also: a look named in the request's text (not in the look input) is
 * applied. The agent is always the run's own (runCtx), never the input's.
 * Fal is faked; nothing real is called.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const MAJA = "33333333-3333-4333-8333-333333333333";
const OLE = "34343434-3434-4343-8343-343434343434";
const GONE = "35353535-3535-4353-8353-353535353535";
const FOREIGN_AGENT = "36363636-3636-4363-8363-363636363636";
const RUN = "44444444-4444-4444-8444-444444444444";

const majaRun = { agentId: MAJA, runId: RUN, companyId: COMPANY, projectId: "" };
const oleRun = { ...majaRun, agentId: OLE };

const looksKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "looks" };
const defaultsKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "lookDefaults" };

const owner = { actor: { type: "user" as const, userId: "owner-1", canManageCompany: true }, companyId: COMPANY };
const member = { actor: { type: "user" as const, userId: "member-1", canManageCompany: false }, companyId: COMPANY };
const agentActor = { actor: { type: "agent" as const, agentId: MAJA }, companyId: COMPANY };

function look(id: string, name: string, extra: Partial<Look> = {}) {
  return {
    id,
    name,
    style: `${name.toLowerCase()} style`,
    model: null,
    seed: null,
    referenceFileIds: [],
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...extra,
  };
}

const NIGHT = look("look-night", "Maja Night", { seed: 4242 });
const CATALOGUE = look("look-cat", "Catalogue", { model: "fal-ai/flux/dev" });

function agent(id: string, name: string, companyId = COMPANY, status = "idle") {
  return { id, companyId, name, title: name === "Maja" ? "Social media" : null, status } as never;
}

async function setup(looks: unknown[] = [NIGHT, CATALOGUE], defaults?: Record<string, string>): Promise<TestHarness> {
  const harness = createTestHarness({ manifest, config: { provider: "fal", falKeySecretRef: "fal-key-ref" } });
  harness.seed({
    agents: [
      agent(MAJA, "Maja"),
      agent(OLE, "Ole"),
      agent(GONE, "Gone", COMPANY, "terminated"),
      agent(FOREIGN_AGENT, "Stranger", OTHER_COMPANY),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  await harness.ctx.state.set(looksKey, looks);
  if (defaults) await harness.ctx.state.set(defaultsKey, defaults);
  return harness;
}

/** A fake Fal: records each generation request and answers with one picture. */
function fakeFal(harness: TestHarness) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://fal.run/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(
        JSON.stringify({ images: [{ url: "https://v3.fal.media/files/out.jpg", content_type: "image/jpeg" }], seed: body.seed ?? 5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }) as typeof harness.ctx.http.fetch;
  return calls;
}

describe("media-studio default look per agent: making pictures", () => {
  it("uses the calling agent's default look when no look is named, and says so", async () => {
    const harness = await setup(undefined, { [MAJA]: NIGHT.id });
    const calls = fakeFal(harness);

    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa by the window" }, majaRun);

    expect(result.error).toBeUndefined();
    expect(calls[0]!.body.prompt).toBe("a sofa by the window\n\nStyle: maja night style");
    expect(calls[0]!.body.seed).toBe(4242);
    expect(result.data).toMatchObject({ look: "Maja Night", lookReason: "agent-default" });
    expect(result.content).toContain('Used the saved look "Maja Night" (your default look, because no look was named).');
  });

  it("uses nothing for an agent without a default, and ignores a default whose look is gone", async () => {
    const harness = await setup(undefined, { [MAJA]: "look-deleted-meanwhile" });
    const calls = fakeFal(harness);
    const maja = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa" }, majaRun);
    const ole = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa" }, oleRun);
    expect(calls.map((c) => c.body.prompt)).toEqual(["a sofa", "a sofa"]);
    expect(maja.data).toMatchObject({ look: null, lookReason: null });
    expect(ole.content).not.toContain("Used the saved look");
  });

  it("lets an explicit look win over the default", async () => {
    const harness = await setup(undefined, { [MAJA]: NIGHT.id });
    const calls = fakeFal(harness);
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", look: "catalogue" }, majaRun);
    expect(calls[0]!.url).toBe("https://fal.run/fal-ai/flux/dev");
    expect(calls[0]!.body.prompt).toBe("a sofa\n\nStyle: catalogue style");
    expect(result.data).toMatchObject({ look: "Catalogue", lookReason: "look-input" });
    expect(result.content).toContain('Used the saved look "Catalogue".');
  });

  it("matches a saved look by name case-insensitively (DUR-4371: 'Maja night' for the saved look 'Maja Night')", async () => {
    const harness = await setup();
    const calls = fakeFal(harness);
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", look: "Maja night" }, majaRun);
    expect(calls[0]!.body.prompt).toBe("a sofa\n\nStyle: maja night style");
    expect(result.data).toMatchObject({ look: "Maja Night", lookReason: "look-input" });
  });

  it("takes the agent from the run, never from the input", async () => {
    const harness = await setup(undefined, { [OLE]: CATALOGUE.id });
    const calls = fakeFal(harness);
    // Maja has no default; naming Ole in the input does not borrow his.
    const maja = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", agentId: OLE } as any, majaRun);
    expect(maja.data.look).toBeNull();
    // Ole's run gets Ole's default whatever the input says.
    const ole = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", agentId: MAJA } as any, oleRun);
    expect(ole.data).toMatchObject({ look: "Catalogue", lookReason: "agent-default" });
    expect(calls.map((c) => c.url)).toEqual(["https://fal.run/fal-ai/flux/schnell", "https://fal.run/fal-ai/flux/dev"]);
  });

  it("applies a look the request's text names, and it beats the default", async () => {
    const harness = await setup(undefined, { [MAJA]: CATALOGUE.id });
    const calls = fakeFal(harness);
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa at dusk, in look maja night" }, majaRun);
    expect(result.error).toBeUndefined();
    expect(calls[0]!.url).toBe("https://fal.run/fal-ai/flux/schnell");
    expect(calls[0]!.body.prompt).toBe("a sofa at dusk, in look maja night\n\nStyle: maja night style");
    expect(result.data).toMatchObject({ look: "Maja Night", lookReason: "named-in-request" });
    expect(result.content).toContain('Used the saved look "Maja Night" (named in the request).');
  });

  it("refuses a request that names two looks, before using up the day's limit", async () => {
    const harness = await setup(undefined, { [MAJA]: CATALOGUE.id });
    const calls = fakeFal(harness);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "Maja Night banner for the catalogue" }, majaRun);
    expect(result.error).toBe('The request names more than one saved look ("Maja Night", "Catalogue"). Pass the one to use as look.');
    expect(reserve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("never reads another company's defaults", async () => {
    const harness = await setup();
    await harness.ctx.state.set({ ...defaultsKey, scopeId: OTHER_COMPANY }, { [MAJA]: NIGHT.id });
    fakeFal(harness);
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa" }, majaRun);
    expect(result.data.look).toBeNull();
  });

  // DUR-4133: the morning report's mood picture must never carry Maja's (or
  // any) look, even though she has a default. `look: "none"` skips every
  // source — named, mentioned in the request text, automatic rule, default —
  // not just the absence of an explicit look (which still falls through to
  // the default, the bug this ticket fixed).
  it('"none" skips the agent\'s default look, an automatic look, and a look named in the request text', async () => {
    const harness = await setup(undefined, { [MAJA]: NIGHT.id });
    const calls = fakeFal(harness);

    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa in look Maja Night", look: "none" }, majaRun);

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ look: null, lookReason: null });
    expect(calls[0]!.body.prompt).toBe("a sofa in look Maja Night");
    expect(calls[0]!.body.seed).toBeUndefined();
  });
});

describe("media-studio: a look named in the request's text", () => {
  const B = look("look-b", "B") as unknown as Look;
  const OAK = look("look-oak", "Oak") as unknown as Look;
  const MAJA_LOOK = look("look-maja", "Maja") as unknown as Look;
  const NIGHT_LOOK = NIGHT as unknown as Look;
  const all = [B, OAK, MAJA_LOOK, NIGHT_LOOK];
  const named = (prompt: string) => {
    const found = lookMentionedIn(prompt, all);
    if (!found) return null;
    return "look" in found ? found.look.name : found.ambiguous.map((l) => l.name);
  };

  it("matches whole words, case-insensitive, in either order around the word look", () => {
    expect(named("a sofa in look Maja Night")).toBe("Maja Night");
    expect(named("MAJA NIGHT look, a sofa")).toBe("Maja Night");
    expect(named("a sofa, maja   night please")).toBe("Maja Night");
    expect(named("a sofa in the Maja Night-look")).toBe("Maja Night");
    expect(named("a chair of oak")).toBe("Oak");
  });

  it("never matches inside other words", () => {
    expect(named("an oakwood table in the soaking rain")).toBeNull();
    expect(named("a majestic sofa at midnight")).toBeNull();
    expect(named("lookout tower")).toBeNull();
  });

  it("takes a one- or two-letter name only right next to the word look", () => {
    expect(named("a big B on a wall")).toBeNull();
    expect(named("plan B for the shop")).toBeNull();
    expect(named("a sofa in look B")).toBe("B");
    expect(named("a sofa, B look")).toBe("B");
    expect(named('a sofa with look: "b"')).toBe("B");
    expect(named("a sofa with lookB")).toBeNull();
    expect(lookMentionedIn("a sofa in look AB", [look("l2", "AB") as unknown as Look])).toMatchObject({ look: { name: "AB" } });
  });

  it("prefers the longer name and the one next to the word look", () => {
    // "Maja" is inside "Maja Night": the longer name wins.
    expect(named("a sofa in look Maja Night")).toBe("Maja Night");
    expect(named("Maja on an oak chair")).toEqual(["Oak", "Maja"]);
    // Next to "look" beats only mentioned.
    expect(named("Maja on an oak chair, look B")).toBe("B");
  });

  it("treats a name's special characters as plain text", () => {
    const odd = look("l3", "Catalogue (v2)") as unknown as Look;
    expect(lookMentionedIn("in look catalogue (v2)", [odd])).toMatchObject({ look: { name: "Catalogue (v2)" } });
    expect(lookMentionedIn("in look catalogue v2", [odd])).toBeNull();
  });
});

describe("media-studio default look per agent: the looks page", () => {
  it("lists the company's agents (not terminated ones, not another company's) with their defaults", async () => {
    const harness = await setup(undefined, { [MAJA]: NIGHT.id, [OLE]: "look-deleted-meanwhile" });
    const listed = await harness.performAction<any>("looks.defaults.list", {}, member);
    expect(listed.agents).toEqual([
      { id: MAJA, name: "Maja", title: "Social media" },
      { id: OLE, name: "Ole", title: null },
    ]);
    expect(listed.defaults).toEqual({ [MAJA]: NIGHT.id });
    expect(listed.canManage).toBe(false);
    expect((await harness.performAction<any>("looks.defaults.list", {}, owner)).canManage).toBe(true);
  });

  it("lets only an owner/admin set or clear a default, for this company's agents and saved looks", async () => {
    const harness = await setup();
    await expect(harness.performAction("looks.defaults.set", { agentId: MAJA, lookId: NIGHT.id }, member)).rejects.toThrow(
      "Only the company's owner or an admin",
    );
    await expect(harness.performAction("looks.defaults.set", { agentId: MAJA, lookId: NIGHT.id }, agentActor)).rejects.toThrow(
      "Only the company's owner or an admin",
    );
    expect(await harness.ctx.state.get(defaultsKey)).toBeNull();

    await expect(harness.performAction("looks.defaults.set", { agentId: FOREIGN_AGENT, lookId: NIGHT.id }, owner)).rejects.toThrow(
      "That agent is not in this company.",
    );
    await expect(harness.performAction("looks.defaults.set", { agentId: GONE, lookId: NIGHT.id }, owner)).rejects.toThrow(
      "That agent is not in this company.",
    );
    await expect(harness.performAction("looks.defaults.set", { agentId: MAJA, lookId: "no-such-look" }, owner)).rejects.toThrow(
      "That look no longer exists.",
    );

    const set = await harness.performAction<any>("looks.defaults.set", { agentId: MAJA, lookId: NIGHT.id }, owner);
    expect(set.defaults).toEqual({ [MAJA]: NIGHT.id });
    await harness.performAction("looks.defaults.set", { agentId: OLE, lookId: CATALOGUE.id }, owner);
    const cleared = await harness.performAction<any>("looks.defaults.set", { agentId: MAJA, lookId: null }, owner);
    expect(cleared.defaults).toEqual({ [OLE]: CATALOGUE.id });
    expect(harness.getState(defaultsKey)).toEqual({ [OLE]: CATALOGUE.id });
  });

  it("clears the defaults that point at a deleted look, and keeps a default through a rename", async () => {
    const harness = await setup(undefined, { [MAJA]: NIGHT.id, [OLE]: CATALOGUE.id });
    const renamed = await harness.performAction<any>(
      "looks.save",
      { id: NIGHT.id, name: "Maja Midnight", style: "dark", model: "", seed: "", referenceFileIds: [] },
      owner,
    );
    expect(renamed.looks.find((l: any) => l.id === NIGHT.id).name).toBe("Maja Midnight");
    fakeFal(harness);
    expect((await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa" }, majaRun)).data.look).toBe("Maja Midnight");

    const afterDelete = await harness.performAction<any>("looks.delete", { id: NIGHT.id }, owner);
    expect(afterDelete.defaults).toEqual({ [OLE]: CATALOGUE.id });
    expect(harness.getState(defaultsKey)).toEqual({ [OLE]: CATALOGUE.id });
    expect((await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa" }, majaRun)).data.look).toBeNull();
  });
});

describe("media-studio list-looks with a default look", () => {
  it("marks the calling agent's default look, and only for that agent", async () => {
    const harness = await setup(undefined, { [MAJA]: NIGHT.id });
    const maja = await harness.executeTool<any>(TOOL_LIST_LOOKS, {}, majaRun);
    expect(maja.content).toContain("- Maja Night: maja night style (your default look: used when you name no look; fixed seed 4242)");
    expect(maja.content).toContain('Your default look is "Maja Night": it is used for every picture where no look is named.');
    expect(maja.content).toContain("- Catalogue: catalogue style (model fal-ai/flux/dev)");
    expect(maja.data.defaultLook).toBe("Maja Night");
    expect(maja.data.looks.map((l: any) => [l.name, l.yourDefault])).toEqual([
      ["Maja Night", true],
      ["Catalogue", false],
    ]);

    const ole = await harness.executeTool<any>(TOOL_LIST_LOOKS, {}, oleRun);
    expect(ole.content).not.toContain("default look");
    expect(ole.data.defaultLook).toBeNull();
  });
});

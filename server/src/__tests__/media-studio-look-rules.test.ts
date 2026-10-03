import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE, TOOL_LIST_LOOKS } from "../../../packages/plugins/media-studio/src/manifest.js";
import {
  checkRule,
  containsKeyword,
  firstApplicableRule,
  localClock,
  windowHolds,
  type LookRuleSet,
} from "../../../packages/plugins/media-studio/src/look-rules.js";

/**
 * Media Studio's automatic looks ("look rules"): an ordered list of rules per
 * person (or per job without a person) that picks a saved look by time of day
 * and by keywords in the person's own message. The clock is faked (Date only)
 * and Fal is faked; nothing real is called.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const MAJA = "33333333-3333-4333-8333-333333333333";
const MAJA_SALES = "33333333-3333-4333-8333-333333333334";
const OLE = "34343434-3434-4343-8343-343434343434";
const PERSONA_MAJA = "55555555-5555-4555-8555-555555555555";
const RUN = "44444444-4444-4444-8444-444444444444";

const majaRun = { agentId: MAJA, runId: RUN, companyId: COMPANY, projectId: "" };
const salesRun = { ...majaRun, agentId: MAJA_SALES };
const oleRun = { ...majaRun, agentId: OLE };

const looksKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "looks" };
const defaultsKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "lookDefaults" };
const rulesKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "lookRules" };

const owner = { actor: { type: "user" as const, userId: "owner-1", canManageCompany: true }, companyId: COMPANY };
const member = { actor: { type: "user" as const, userId: "member-1", canManageCompany: false }, companyId: COMPANY };
const agentActor = { actor: { type: "agent" as const, agentId: MAJA }, companyId: COMPANY };

function look(id: string, name: string) {
  return { id, name, style: `${name.toLowerCase()} style`, model: null, seed: null, referenceFileIds: [], updatedAt: "2026-09-28T00:00:00.000Z" };
}

const DEFAULT_LOOK = look("look-default", "Everyday");
const AFTERNOON = look("look-afternoon", "Afternoon");
const WORK = look("look-work", "Office");
const NIGHT = look("look-night", "Night");
const CATALOGUE = look("look-cat", "Catalogue");

const MAJA_KEY = `persona:${PERSONA_MAJA}`;
const OLE_KEY = `agent:${OLE}`;

/** The operator's example: 13-18 above a 'work' keyword rule. */
const OPERATOR_RULES: LookRuleSet = {
  timezone: "Europe/Oslo",
  rules: [
    { id: "r-afternoon", lookId: AFTERNOON.id, enabled: true, timeWindows: [{ from: "13:00", to: "18:00" }] },
    { id: "r-work", lookId: WORK.id, enabled: true, keywords: ["work"] },
  ],
};

function agent(id: string, name: string, personaId: string | null, companyId = COMPANY, status = "idle") {
  return {
    id,
    companyId,
    name,
    title: null,
    status,
    personaId,
    persona: personaId ? { id: personaId, displayName: "Maja", pronouns: null, avatarAssetId: null } : null,
  } as never;
}

async function setup(rules?: Record<string, LookRuleSet>, defaults: Record<string, string> = { [MAJA]: DEFAULT_LOOK.id }) {
  const harness = createTestHarness({ manifest, config: { provider: "fal", falKeySecretRef: "fal-key-ref" } });
  harness.seed({
    agents: [
      agent(MAJA, "Maja (social media)", PERSONA_MAJA),
      agent(MAJA_SALES, "Maja (sales)", PERSONA_MAJA),
      agent(OLE, "Ole", null),
      agent("36363636-3636-4363-8363-363636363636", "Gone", null, COMPANY, "terminated"),
      agent("37373737-3737-4373-8373-373737373737", "Stranger", null, OTHER_COMPANY),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  await harness.ctx.state.set(looksKey, [DEFAULT_LOOK, AFTERNOON, WORK, NIGHT, CATALOGUE]);
  await harness.ctx.state.set(defaultsKey, defaults);
  if (rules) await harness.ctx.state.set(rulesKey, rules);
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
        JSON.stringify({ images: [{ url: "https://v3.fal.media/files/out.jpg", content_type: "image/jpeg" }], seed: 5 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }) as typeof harness.ctx.http.fetch;
  return calls;
}

/** Freeze the clock (Date only, so the fake Fal's promises still run). */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

afterEach(() => {
  vi.useRealTimers();
});

async function picture(harness: TestHarness, params: Record<string, unknown>, run: Record<string, unknown> = majaRun) {
  return harness.executeTool<any>(TOOL_GENERATE, params, run as never);
}

describe("automatic looks: the operator's example", () => {
  // 2026-09-28 is a Monday; Oslo is on summer time (UTC+2).
  it("picks by the first rule that fits right now, and falls back to the default look", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES });
    const calls = fakeFal(harness);

    // 08:00 with "work": the 13-18 rule does not fit now, so the work rule wins.
    at("2026-09-28T06:00:00Z");
    const morning = await picture(harness, { prompt: "a desk with a laptop" }, { ...majaRun, requesterMessage: "Can you make a picture for work?" });
    expect(morning.error).toBeUndefined();
    expect(morning.data).toMatchObject({ look: "Office", lookReason: "rule", lookReasonText: "rule: keyword 'work'" });
    expect(morning.content).toContain('Used the saved look "Office" (automatic look, rule: keyword \'work\', because no look was named).');
    expect(calls[0]!.body.prompt).toBe("a desk with a laptop\n\nStyle: office style");

    // 14:00 with "work": the 13-18 rule is higher and fits, so it wins.
    at("2026-09-28T12:00:00Z");
    const afternoonWork = await picture(harness, { prompt: "a desk" }, { ...majaRun, requesterMessage: "a picture for work please" });
    expect(afternoonWork.data).toMatchObject({ look: "Afternoon", lookReason: "rule", lookReasonText: "rule: 13:00–18:00" });

    // 14:00 without a keyword: the 13-18 rule.
    const afternoon = await picture(harness, { prompt: "a sofa" }, { ...majaRun, requesterMessage: "make a sofa picture" });
    expect(afternoon.data).toMatchObject({ look: "Afternoon", lookReasonText: "rule: 13:00–18:00" });

    // 20:00, no keyword: nothing fits, so the default look.
    at("2026-09-28T18:00:00Z");
    const evening = await picture(harness, { prompt: "a sofa" }, { ...majaRun, requesterMessage: "make a sofa picture" });
    expect(evening.data).toMatchObject({ look: "Everyday", lookReason: "agent-default", lookReasonText: "default look" });
    expect(evening.content).toContain('Used the saved look "Everyday" (your default look, because no look was named).');
  });

  it("uses no look at all when nothing fits and there is no default", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES }, {});
    fakeFal(harness);
    at("2026-09-28T18:00:00Z");
    const result = await picture(harness, { prompt: "a sofa" });
    expect(result.data).toMatchObject({ look: null, lookReason: null, lookReasonText: null });
    expect(result.content).not.toContain("Used the saved look");
  });

  it("also finds a keyword in the picture's description when there is no person's message (full agents)", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES });
    fakeFal(harness);
    at("2026-09-28T06:00:00Z");
    expect((await picture(harness, { prompt: "a desk at work" })).data).toMatchObject({ look: "Office", lookReasonText: "rule: keyword 'work'" });
    expect((await picture(harness, { prompt: "a desk" })).data).toMatchObject({ look: "Everyday" });
  });
});

describe("automatic looks: the person's message comes from the host only", () => {
  it("ignores a requester message or a clock the tool input claims", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES });
    fakeFal(harness);
    at("2026-09-28T06:00:00Z");
    const faked = await picture(harness, {
      prompt: "a desk",
      requesterMessage: "work",
      runContext: { requesterMessage: "work" },
      now: "2026-09-28T12:00:00Z",
    });
    expect(faked.data).toMatchObject({ look: "Everyday", lookReason: "agent-default" });
    // The same words from the host (a quick-agent chat turn) do count.
    const real = await picture(harness, { prompt: "a desk" }, { ...majaRun, requesterMessage: "work" });
    expect(real.data).toMatchObject({ look: "Office", lookReason: "rule" });
  });

  it("follows the run's own agent and its person, never an agent named in the input", async () => {
    const harness = await setup({ [OLE_KEY]: { timezone: "Europe/Oslo", rules: [{ id: "o", lookId: NIGHT.id, enabled: true, keywords: ["sofa"] }] } });
    fakeFal(harness);
    at("2026-09-28T12:00:00Z");
    // Maja has no "sofa" rule; naming Ole in the input does not borrow his.
    expect((await picture(harness, { prompt: "a sofa", agentId: OLE })).data).toMatchObject({ look: "Everyday" });
    expect((await picture(harness, { prompt: "a sofa" }, oleRun)).data).toMatchObject({ look: "Night", lookReason: "rule" });
  });
});

describe("automatic looks: people and jobs", () => {
  it("shares a person's rules with every job that person holds; a job without a person has its own", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES, [OLE_KEY]: { timezone: "UTC", rules: [{ id: "x", lookId: NIGHT.id, enabled: true, keywords: ["work"] }] } });
    fakeFal(harness);
    at("2026-09-28T12:00:00Z");
    expect((await picture(harness, { prompt: "a sofa" }, salesRun)).data).toMatchObject({ look: "Afternoon", lookReason: "rule" });
    expect((await picture(harness, { prompt: "a desk for work" }, oleRun)).data).toMatchObject({ look: "Night", lookReason: "rule" });
    // Maja's own job rules (agent key) are not used while she has a person.
    await harness.ctx.state.set(rulesKey, { [`agent:${MAJA}`]: { timezone: "UTC", rules: [{ id: "y", lookId: NIGHT.id, enabled: true, keywords: ["sofa"] }] } });
    expect((await picture(harness, { prompt: "a sofa" })).data).toMatchObject({ look: "Everyday", lookReason: "agent-default" });
  });

  it("never reads another company's rules", async () => {
    const harness = await setup();
    await harness.ctx.state.set({ ...rulesKey, scopeId: OTHER_COMPANY }, { [MAJA_KEY]: OPERATOR_RULES });
    fakeFal(harness);
    at("2026-09-28T12:00:00Z");
    expect((await picture(harness, { prompt: "a sofa" })).data).toMatchObject({ look: "Everyday", lookReason: "agent-default" });
  });
});

describe("automatic looks: what wins", () => {
  it("a look passed as look, or named in the request, wins over a rule", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES });
    fakeFal(harness);
    at("2026-09-28T12:00:00Z");
    expect((await picture(harness, { prompt: "a sofa", look: "Catalogue" })).data).toMatchObject({ look: "Catalogue", lookReason: "look-input", lookReasonText: "named as the look" });
    expect((await picture(harness, { prompt: "a sofa in look night" })).data).toMatchObject({
      look: "Night",
      lookReason: "named-in-request",
      lookReasonText: "named in the request",
    });
  });

  it("skips a switched-off rule and a rule whose look is gone", async () => {
    const harness = await setup({
      [MAJA_KEY]: {
        timezone: "Europe/Oslo",
        rules: [
          { id: "off", lookId: CATALOGUE.id, enabled: false, timeWindows: [{ from: "00:00", to: "24:00" }] },
          { id: "gone", lookId: "look-deleted", enabled: true, timeWindows: [{ from: "00:00", to: "24:00" }] },
          { id: "on", lookId: NIGHT.id, enabled: true, timeWindows: [{ from: "00:00", to: "24:00" }] },
        ],
      },
    });
    fakeFal(harness);
    at("2026-09-28T12:00:00Z");
    expect((await picture(harness, { prompt: "a sofa" })).data).toMatchObject({ look: "Night", lookReasonText: "rule: 00:00–24:00" });
  });
});

describe("automatic looks: time windows", () => {
  const clock = (iso: string, tz = "Europe/Oslo") => localClock(new Date(iso), tz);

  it("runs past midnight, counting the day the window starts on", () => {
    const friNight = { from: "22:00", to: "02:00", days: ["fri" as const] };
    // 2026-10-02 is a Friday. Oslo is UTC+2.
    expect(windowHolds(friNight, clock("2026-10-02T21:00:00Z"))).toBe(true); // Fri 23:00
    expect(windowHolds(friNight, clock("2026-10-02T23:00:00Z"))).toBe(true); // Sat 01:00
    expect(windowHolds(friNight, clock("2026-10-03T00:00:00Z"))).toBe(false); // Sat 02:00: the end is not included
    expect(windowHolds(friNight, clock("2026-10-03T20:30:00Z"))).toBe(false); // Sat 22:30
    expect(windowHolds(friNight, clock("2026-10-01T23:00:00Z"))).toBe(false); // Fri 01:00 (Thursday night)
    expect(windowHolds({ from: "22:00", to: "02:00" }, clock("2026-10-01T23:00:00Z"))).toBe(true); // every day
  });

  it("keeps to the picked weekdays", () => {
    const weekdays = { from: "08:00", to: "12:00", days: ["mon", "tue", "wed", "thu", "fri"] as never };
    expect(windowHolds(weekdays, clock("2026-09-28T07:00:00Z"))).toBe(true); // Mon 09:00
    expect(windowHolds(weekdays, clock("2026-09-27T07:00:00Z"))).toBe(false); // Sun 09:00
    expect(windowHolds(weekdays, clock("2026-09-28T10:00:00Z"))).toBe(false); // Mon 12:00
  });

  it("reads the clock in the rule set's time zone, daylight saving included", async () => {
    const morning = (timezone: string): LookRuleSet => ({
      timezone,
      rules: [{ id: "m", lookId: NIGHT.id, enabled: true, timeWindows: [{ from: "08:00", to: "09:00" }] }],
    });
    const fits = (set: LookRuleSet, iso: string) => firstApplicableRule(set, { now: new Date(iso), texts: [] }) !== null;
    // Winter time (Oslo = UTC+1): 07:30 UTC is 08:30 in Oslo.
    expect(fits(morning("Europe/Oslo"), "2026-03-28T07:30:00Z")).toBe(true);
    expect(fits(morning("UTC"), "2026-03-28T07:30:00Z")).toBe(false);
    // Summer time from 29 March (Oslo = UTC+2): 06:30 UTC is 08:30 in Oslo.
    expect(fits(morning("Europe/Oslo"), "2026-03-30T06:30:00Z")).toBe(true);
    expect(fits(morning("Europe/Oslo"), "2026-03-30T07:30:00Z")).toBe(false);
    expect(fits(morning("UTC"), "2026-03-30T08:30:00Z")).toBe(true);

    // The same through the tool, with the time zone saved per person.
    const harness = await setup({ [MAJA_KEY]: morning("UTC") });
    fakeFal(harness);
    at("2026-09-28T08:15:00Z"); // 08:15 UTC, 10:15 in Oslo
    expect((await picture(harness, { prompt: "a sofa" })).data).toMatchObject({ look: "Night", lookReasonText: "rule: 08:00–09:00" });
    await harness.ctx.state.set(rulesKey, { [MAJA_KEY]: morning("Europe/Oslo") });
    expect((await picture(harness, { prompt: "a sofa" })).data).toMatchObject({ look: "Everyday" });
  });

  it("says the weekdays in words", async () => {
    const harness = await setup({
      [MAJA_KEY]: {
        timezone: "Europe/Oslo",
        rules: [{ id: "w", lookId: NIGHT.id, enabled: true, timeWindows: [{ from: "08:00", to: "12:00", days: ["mon", "tue", "wed", "thu", "fri"] }] }],
      },
    });
    fakeFal(harness);
    at("2026-09-28T07:00:00Z");
    expect((await picture(harness, { prompt: "a sofa" })).data.lookReasonText).toBe("rule: 08:00–12:00 on weekdays");
  });
});

describe("automatic looks: keywords", () => {
  it("matches whole words only, ignoring case", () => {
    expect(containsKeyword("A picture for WORK, please", "work")).toBe(true);
    expect(containsKeyword("work!", "work")).toBe(true);
    expect(containsKeyword("my homework", "work")).toBe(false);
    expect(containsKeyword("a workshop banner", "work")).toBe(false);
    expect(containsKeyword("networking event", "work")).toBe(false);
    expect(containsKeyword("the New   Collection is here", "new collection")).toBe(true);
    expect(containsKeyword("renew collection", "new collection")).toBe(false);
    expect(containsKeyword("et bilde til jobb", "jobb")).toBe(true);
    expect(containsKeyword("jeg skal jobbe", "jobb")).toBe(false);
    expect(containsKeyword("høstkampanje", "høst")).toBe(false);
    expect(containsKeyword("Høst i butikken", "høst")).toBe(true);
    expect(containsKeyword("price (v2) list", "(v2)")).toBe(true);
  });

  it("a rule with both a time and keywords needs both", () => {
    const set: LookRuleSet = {
      timezone: "UTC",
      rules: [{ id: "b", lookId: NIGHT.id, enabled: true, timeWindows: [{ from: "08:00", to: "12:00" }], keywords: ["sale", "offer"] }],
    };
    const pick = (iso: string, text: string) => firstApplicableRule(set, { now: new Date(iso), texts: [text] });
    expect(pick("2026-09-28T09:00:00Z", "a big offer")).toMatchObject({ keyword: "offer", window: { from: "08:00" } });
    expect(pick("2026-09-28T13:00:00Z", "a big offer")).toBeNull();
    expect(pick("2026-09-28T09:00:00Z", "a sofa")).toBeNull();
  });
});

describe("automatic looks: the looks page", () => {
  it("lists people (with their jobs) and jobs without a person, with rules and default looks", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES, [`persona:not-here`]: OPERATOR_RULES });
    const listed = await harness.performAction<any>("lookRules.list", {}, member);
    expect(listed.owners).toEqual([
      {
        key: MAJA_KEY,
        kind: "persona",
        name: "Maja",
        jobs: [
          { id: MAJA_SALES, name: "Maja (sales)", title: null, defaultLookId: null },
          { id: MAJA, name: "Maja (social media)", title: null, defaultLookId: DEFAULT_LOOK.id },
        ],
      },
      { key: OLE_KEY, kind: "agent", name: "Ole", jobs: [{ id: OLE, name: "Ole", title: null, defaultLookId: null }] },
    ]);
    expect(Object.keys(listed.ruleSets)).toEqual([MAJA_KEY]);
    expect(listed.ruleSets[MAJA_KEY].rules.map((r: any) => r.id)).toEqual(["r-afternoon", "r-work"]);
    expect(listed.defaultTimezone).toBe("Europe/Oslo");
    expect(listed.canManage).toBe(false);
    expect((await harness.performAction<any>("lookRules.list", {}, owner)).canManage).toBe(true);
  });

  it("lets only an owner/admin save rules, in the order given", async () => {
    const harness = await setup();
    const params = { ownerKey: MAJA_KEY, timezone: "Europe/Oslo", rules: [OPERATOR_RULES.rules[1], OPERATOR_RULES.rules[0]] };
    await expect(harness.performAction("lookRules.save", params, member)).rejects.toThrow("Only the company's owner or an admin");
    await expect(harness.performAction("lookRules.save", params, agentActor)).rejects.toThrow("Only the company's owner or an admin");
    expect(harness.getState(rulesKey)).toBeUndefined();

    const saved = await harness.performAction<any>("lookRules.save", params, owner);
    expect(saved.ruleSet.rules.map((r: any) => r.id)).toEqual(["r-work", "r-afternoon"]);
    expect((harness.getState(rulesKey) as any)[MAJA_KEY].rules.map((r: any) => r.id)).toEqual(["r-work", "r-afternoon"]);

    // Reordered: now the keyword rule is on top, so at 14:00 "work" picks Office.
    fakeFal(harness);
    at("2026-09-28T12:00:00Z");
    expect((await picture(harness, { prompt: "a desk" }, { ...majaRun, requesterMessage: "for work" })).data).toMatchObject({ look: "Office" });
  });

  it("refuses rules that cannot work, in plain words", async () => {
    const harness = await setup();
    const save = (rules: unknown[], extra: Record<string, unknown> = {}) =>
      harness.performAction("lookRules.save", { ownerKey: MAJA_KEY, timezone: "Europe/Oslo", rules, ...extra }, owner);
    await expect(save([{ lookId: NIGHT.id, enabled: true }])).rejects.toThrow("Rule 1 needs a time or a keyword (or both)");
    await expect(save([{ lookId: NIGHT.id, keywords: ["  "] }])).rejects.toThrow("Rule 1 needs a time or a keyword");
    await expect(save([{ lookId: NIGHT.id, timeWindows: [{ from: "8", to: "12:00" }] }])).rejects.toThrow("Rule 1: times are written like 08:00 or 17:30.");
    await expect(save([{ lookId: NIGHT.id, timeWindows: [{ from: "08:00", to: "08:00" }] }])).rejects.toThrow("the start and end time are the same");
    await expect(save([{ lookId: NIGHT.id, timeWindows: [{ from: "08:00", to: "09:00", days: [] }] }])).rejects.toThrow("pick at least one day");
    await expect(save([{ lookId: "look-deleted", keywords: ["x"] }])).rejects.toThrow("Rule 1: that look no longer exists.");
    await expect(save([{ lookId: NIGHT.id, keywords: ["x"] }], { timezone: "Mars/Olympus" })).rejects.toThrow("Pick a time zone from the list.");
    await expect(
      harness.performAction("lookRules.save", { ownerKey: `agent:${MAJA}`, rules: [{ lookId: NIGHT.id, keywords: ["x"] }] }, owner),
    ).rejects.toThrow("follows that person's automatic looks. Pick the person instead.");
    await expect(
      harness.performAction("lookRules.save", { ownerKey: "agent:37373737-3737-4373-8373-373737373737", rules: [] }, owner),
    ).rejects.toThrow("That person or agent is not in this company.");
    expect(harness.getState(rulesKey)).toBeUndefined();

    // Keywords are tidied (trimmed, duplicates dropped); every day is saved as no days.
    const ok = await save([{ lookId: NIGHT.id, keywords: [" Work ", "work", "new   collection"], timeWindows: [{ from: "08:00", to: "24:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }] }]);
    expect((ok as any).ruleSet.rules[0]).toMatchObject({ lookId: NIGHT.id, enabled: true, keywords: ["Work", "new collection"], timeWindows: [{ from: "08:00", to: "24:00" }] });
    expect(() => checkRule({ lookId: "l", keywords: ["!!"] })).toThrow("a keyword needs at least one letter or number");
  });

  it("removes the rules that point at a deleted look", async () => {
    const harness = await setup({
      [MAJA_KEY]: OPERATOR_RULES,
      [OLE_KEY]: { timezone: "UTC", rules: [{ id: "o", lookId: WORK.id, enabled: true, keywords: ["desk"] }] },
    });
    const res = await harness.performAction<any>("looks.delete", { id: WORK.id }, owner);
    expect(res.lookRules[MAJA_KEY].rules.map((r: any) => r.id)).toEqual(["r-afternoon"]);
    expect(res.lookRules[OLE_KEY].rules).toEqual([]);
    expect((harness.getState(rulesKey) as any)[MAJA_KEY].rules).toHaveLength(1);
  });

  it("previews what would be picked right now, for anyone in the company", async () => {
    const harness = await setup({ [MAJA_KEY]: OPERATOR_RULES });
    at("2026-09-28T06:00:00Z");
    const withWork = await harness.performAction<any>("lookRules.preview", { ownerKey: MAJA_KEY, message: "a picture for work" }, member);
    expect(withWork).toMatchObject({
      timezone: "Europe/Oslo",
      localTime: "Monday 08:00",
      rule: { id: "r-work", position: 2, lookName: "Office", why: "rule: keyword 'work'" },
    });
    const none = await harness.performAction<any>("lookRules.preview", { ownerKey: MAJA_KEY, message: "hello" }, member);
    expect(none.rule).toBeNull();
    expect(none.fallbacks).toEqual([
      { agentId: MAJA_SALES, agentName: "Maja (sales)", lookName: null },
      { agentId: MAJA, agentName: "Maja (social media)", lookName: "Everyday" },
    ]);
  });
});

describe("automatic looks: list-looks tells the agent", () => {
  it("lists the calling agent's switched-on rules in plain words", async () => {
    const harness = await setup({
      [MAJA_KEY]: {
        ...OPERATOR_RULES,
        rules: [
          ...OPERATOR_RULES.rules,
          { id: "off", lookId: NIGHT.id, enabled: false, keywords: ["night"] },
          { id: "wk", lookId: NIGHT.id, enabled: true, timeWindows: [{ from: "20:00", to: "02:00", days: ["sat", "sun"] }] },
        ],
      },
    });
    at("2026-09-28T12:00:00Z");
    const maja = await harness.executeTool<any>(TOOL_LIST_LOOKS, {}, majaRun);
    expect(maja.content).toContain(
      "Automatic looks: when no look is named, these are checked from the top and the first that fits is used (times are Europe/Oslo time;",
    );
    expect(maja.content).toContain('1. "Afternoon": from 13:00 to 18:00.');
    expect(maja.content).toContain('2. "Office": when the message says "work".');
    expect(maja.content).toContain('3. "Night": from 20:00 to 02:00 at weekends.');
    expect(maja.content).not.toContain('"night"');
    expect(maja.content).toContain('Right now, without any keyword, "Afternoon" would be used (rule: 13:00–18:00).');
    expect(maja.content).toContain('Your default look is "Everyday": it is used for every picture where no look is named and no automatic look fits.');
    expect(maja.data.automaticLooks.rules).toHaveLength(3);

    // Ole has no rules: nothing about automatic looks.
    const ole = await harness.executeTool<any>(TOOL_LIST_LOOKS, {}, oleRun);
    expect(ole.content).not.toContain("Automatic looks");
    expect(ole.data.automaticLooks).toBeNull();
  });
});

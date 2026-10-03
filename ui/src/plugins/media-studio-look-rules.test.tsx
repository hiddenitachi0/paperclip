// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaStudioLooksPage,
  daysInWords,
  moveRule,
  ruleInWords,
  ruleIsReady,
} from "../../../packages/plugins/media-studio/src/ui/index";

/**
 * Media Studio's "Automatic looks" section (Company settings, Media Studio
 * looks): pick a person or a job, see and reorder the rules (drag and drop or
 * the arrows), add one, switch one off, change the time zone, and try a
 * message in the "right now this would pick" preview. The plugin's actions are
 * stubbed through the plugin UI bridge; the worker's own tests cover what
 * fits when.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MAJA = "33333333-3333-4333-8333-333333333333";
const MAJA_SALES = "33333333-3333-4333-8333-333333333334";
const OLE = "34343434-3434-4343-8343-343434343434";
const MAJA_KEY = "persona:55555555-5555-4555-8555-555555555555";
const OLE_KEY = `agent:${OLE}`;

const savedLooks = [
  { id: "look-default", name: "Everyday", style: "", model: null, seed: null, referenceFileIds: [], updatedAt: "x" },
  { id: "look-afternoon", name: "Afternoon", style: "", model: null, seed: null, referenceFileIds: [], updatedAt: "x" },
  { id: "look-work", name: "Office", style: "", model: null, seed: null, referenceFileIds: [], updatedAt: "x" },
];

const RULES = [
  { id: "r-afternoon", lookId: "look-afternoon", enabled: true, timeWindows: [{ from: "13:00", to: "18:00" }] },
  { id: "r-work", lookId: "look-work", enabled: true, keywords: ["work"] },
];

const actions: Record<string, ReturnType<typeof vi.fn>> = {};

function installBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__paperclipPluginBridge__ = {
    sdkUi: { usePluginAction: (key: string) => actions[key] ?? (actions[key] = vi.fn()) },
  };
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

/** The preview waits a moment after typing stops. */
async function waitForPreview() {
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  await flush();
}

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

function stubActions(canManage: boolean) {
  for (const key of Object.keys(actions)) delete actions[key];
  actions["looks.list"] = vi.fn(async () => ({ looks: savedLooks, canManage, maxReferenceFiles: 4 }));
  actions["looks.defaults.list"] = vi.fn(async () => ({
    agents: [
      { id: MAJA, name: "Maja (social media)", title: null },
      { id: MAJA_SALES, name: "Maja (sales)", title: null },
      { id: OLE, name: "Ole", title: null },
    ],
    defaults: { [MAJA]: "look-default" },
    canManage,
  }));
  actions["lookRules.list"] = vi.fn(async () => ({
    owners: [
      {
        key: MAJA_KEY,
        kind: "persona",
        name: "Maja",
        jobs: [
          { id: MAJA_SALES, name: "Maja (sales)", title: null, defaultLookId: null },
          { id: MAJA, name: "Maja (social media)", title: null, defaultLookId: "look-default" },
        ],
      },
      { key: OLE_KEY, kind: "agent", name: "Ole", jobs: [{ id: OLE, name: "Ole", title: null, defaultLookId: null }] },
    ],
    ruleSets: { [MAJA_KEY]: { timezone: "Europe/Oslo", rules: RULES } },
    defaultTimezone: "Europe/Oslo",
    canManage,
  }));
  // The worker answers with the saved list; new rules get an id.
  actions["lookRules.save"] = vi.fn(async ({ timezone, rules }: { timezone: string; rules: Array<Record<string, unknown>> }) => ({
    ruleSet: { timezone, rules: rules.map((r, i) => ({ ...r, id: r.id ?? `saved-${i}` })) },
  }));
  actions["lookRules.preview"] = vi.fn(async ({ message }: { message: string }) =>
    /\bwork\b/i.test(message)
      ? {
          timezone: "Europe/Oslo",
          localTime: "Monday 08:00",
          rule: { id: "r-work", position: 2, lookId: "look-work", lookName: "Office", why: "rule: keyword 'work'" },
          fallbacks: [],
        }
      : {
          timezone: "Europe/Oslo",
          localTime: "Monday 08:00",
          rule: null,
          fallbacks: [
            { agentId: MAJA_SALES, agentName: "Maja (sales)", lookName: null },
            { agentId: MAJA, agentName: "Maja (social media)", lookName: "Everyday" },
          ],
        },
  );
  installBridge();
}

describe("Media Studio looks page: automatic looks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ artifacts: [] }), { status: 200 })));
    vi.stubGlobal("confirm", () => true);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    root?.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    root = createRoot(container);
    root.render(<MediaStudioLooksPage context={{ companyId: COMPANY } as never} />);
    await flush();
    await waitForPreview();
    return container.querySelector<HTMLElement>('section[aria-label="Automatic looks"]')!;
  }

  const rows = (section: HTMLElement) => [...section.querySelectorAll<HTMLLIElement>('ol[aria-label="Rules in priority order"] > li')];
  const lastSaved = () => actions["lookRules.save"]!.mock.calls.at(-1)![0] as { ownerKey: string; timezone: string; rules: Array<Record<string, unknown>> };

  it("lists the rules in order for the chosen person, with the default look and a live preview", async () => {
    stubActions(true);
    const section = await render();
    const owner = section.querySelector<HTMLSelectElement>('select[aria-label="Person or agent"]')!;
    expect(owner.value).toBe(MAJA_KEY);
    expect([...owner.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["People", "Agents without a person"]);
    expect([...owner.options].map((o) => o.textContent)).toEqual(["Maja (Maja (sales), Maja (social media))", "Ole"]);
    expect(rows(section).map((li) => li.getAttribute("aria-label"))).toEqual([
      "Rule 1: Afternoon, from 13:00 to 18:00",
      'Rule 2: Office, when the message says "work"',
    ]);
    expect(section.textContent).toContain("Default look when no rule fits: Maja (sales): none; Maja (social media): Everyday.");
    const preview = section.querySelector('[data-testid="look-rules-preview"]')!;
    expect(preview.textContent).toContain(
      "Right now (Monday 08:00, Europe/Oslo) no rule fits, so each job uses its default look: Maja (sales): no look; Maja (social media): Everyday.",
    );

    setValue(section.querySelector<HTMLInputElement>('input[aria-label="Test message"]')!, "a picture for work");
    await waitForPreview();
    expect(actions["lookRules.preview"]).toHaveBeenLastCalledWith({ ownerKey: MAJA_KEY, message: "a picture for work" });
    expect(preview.textContent).toContain("Right now (Monday 08:00, Europe/Oslo) this would pick: Office (rule: keyword 'work').");
    expect(rows(section)[1]!.textContent).toContain("Fits right now");

    // Ole: no rules yet, his own default (none).
    setValue(owner, OLE_KEY);
    await waitForPreview();
    expect(section.textContent).toContain("No rules yet for Ole.");
    expect(section.textContent).toContain("Default look when no rule fits: none.");
  });

  it("reorders with the arrows and by drag and drop, saving the new order at once", async () => {
    stubActions(true);
    const section = await render();
    buttonNamed(rows(section)[0]!, "↓").click();
    await flush();
    expect(lastSaved()).toMatchObject({ ownerKey: MAJA_KEY, timezone: "Europe/Oslo" });
    expect(lastSaved().rules.map((r) => r.id)).toEqual(["r-work", "r-afternoon"]);
    expect(rows(section).map((li) => li.getAttribute("aria-label")!.slice(0, 14))).toEqual(["Rule 1: Office", "Rule 2: Aftern"]);
    expect(section.querySelector<HTMLButtonElement>('button[aria-label="Move rule 1 up"]')!.disabled).toBe(true);

    // Drag the second rule (Afternoon) onto the first.
    const handle = section.querySelector<HTMLElement>('[aria-label="Drag rule 2 to another place"]')!;
    handle.dispatchEvent(new Event("dragstart", { bubbles: true }));
    await flush();
    const target = rows(section)[0]!;
    target.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await flush();
    expect(lastSaved().rules.map((r) => r.id)).toEqual(["r-afternoon", "r-work"]);
    expect(actions["lookRules.save"]).toHaveBeenCalledTimes(2);
  });

  it("adds a keyword rule, switches a rule off, deletes one and changes the time zone", async () => {
    stubActions(true);
    const section = await render();
    buttonNamed(section, "Add a rule").click();
    await flush();
    const form = section.querySelector<HTMLElement>('[aria-label="New rule"]')!;
    setValue(form.querySelector<HTMLSelectElement>("select")!, "look-default");
    // Take the suggested time away and use a keyword instead.
    setValue(form.querySelector<HTMLInputElement>('input[aria-label="New keyword for the new rule"]')!, "party");
    await flush();
    buttonNamed(form, "Add keyword").click();
    await flush();
    buttonNamed(form, "Remove time").click();
    await flush();
    buttonNamed(form, "Add rule").click();
    await flush();
    expect(lastSaved().rules).toHaveLength(3);
    expect(lastSaved().rules[2]).toEqual({ lookId: "look-default", enabled: true, timeWindows: [], keywords: ["party"] });
    expect(rows(section)[2]!.getAttribute("aria-label")).toBe('Rule 3: Everyday, when the message says "party"');

    // Switch the first rule off.
    const toggle = section.querySelector<HTMLInputElement>('input[aria-label="rule 1 on"]')!;
    toggle.click();
    await flush();
    expect(lastSaved().rules[0]).toMatchObject({ id: "r-afternoon", enabled: false });

    // A keyword-only rule cannot lose its last keyword.
    expect(rows(section)[1]!.querySelector<HTMLButtonElement>('button[aria-label="Remove keyword work"]')!.disabled).toBe(true);

    // Delete the second rule.
    buttonNamed(rows(section)[1]!, "Delete").click();
    await flush();
    expect(lastSaved().rules.map((r) => r.lookId)).toEqual(["look-afternoon", "look-default"]);

    // Time zone.
    setValue(section.querySelector<HTMLSelectElement>('select[aria-label="Time zone"]')!, "UTC");
    await flush();
    expect(lastSaved().timezone).toBe("UTC");
  });

  it("changes a rule's days and times, and waits to save until a time is complete", async () => {
    stubActions(true);
    const section = await render();
    const first = rows(section)[0]!;
    // Monday off: every day except Monday.
    buttonNamed(first, "Mon").click();
    await flush();
    expect(lastSaved().rules[0]).toMatchObject({ timeWindows: [{ from: "13:00", to: "18:00", days: ["tue", "wed", "thu", "fri", "sat", "sun"] }] });
    const saves = actions["lookRules.save"]!.mock.calls.length;
    setValue(rows(section)[0]!.querySelector<HTMLInputElement>('input[aria-label="From"]')!, "");
    await flush();
    expect(actions["lookRules.save"]!.mock.calls.length).toBe(saves);
    expect(section.textContent).toContain("Not saved yet");
    setValue(rows(section)[0]!.querySelector<HTMLInputElement>('input[aria-label="From"]')!, "22:00");
    await flush();
    expect(lastSaved().rules[0]).toMatchObject({ timeWindows: [{ from: "22:00", to: "18:00" }] });
    expect(rows(section)[0]!.textContent).toContain("(runs past midnight)");
  });

  it("puts the list back and says why when saving fails", async () => {
    stubActions(true);
    actions["lookRules.save"] = vi.fn(async () => {
      throw new Error("Rule 1: that look no longer exists. Reload the page.");
    });
    const section = await render();
    buttonNamed(rows(section)[0]!, "↓").click();
    await flush();
    expect(section.textContent).toContain("Rule 1: that look no longer exists. Reload the page.");
    expect(rows(section)[0]!.getAttribute("aria-label")).toBe("Rule 1: Afternoon, from 13:00 to 18:00");
  });

  it("shows the rules to a member without letting them change anything", async () => {
    stubActions(false);
    const section = await render();
    expect(rows(section)).toHaveLength(2);
    expect(section.querySelector('[aria-label="Drag rule 1 to another place"]')).toBeNull();
    expect(section.querySelector('button[aria-label="Move rule 1 down"]')).toBeNull();
    expect(section.querySelector<HTMLInputElement>('input[aria-label="rule 1 on"]')!.disabled).toBe(true);
    expect(section.querySelector<HTMLSelectElement>('select[aria-label="Time zone"]')!.disabled).toBe(true);
    expect([...section.querySelectorAll("button")].some((b) => b.textContent === "Add a rule")).toBe(false);
    expect(section.textContent).toContain("Only the company's owner or an admin can change automatic looks.");
    // The preview still works for them.
    expect(section.querySelector('input[aria-label="Test message"]')).not.toBeNull();
  });
});

describe("automatic looks helpers", () => {
  it("says rules and days in words and knows when a rule can be saved", () => {
    expect(daysInWords(["mon", "tue", "wed", "thu", "fri"])).toBe("on weekdays");
    expect(daysInWords(["sat", "sun"])).toBe("at weekends");
    expect(daysInWords(["mon", "wed"])).toBe("on Mon, Wed");
    expect(daysInWords(undefined)).toBe("");
    expect(ruleInWords({ lookId: "look-work", enabled: true, keywords: ["work", "office"], timeWindows: [{ from: "08:00", to: "12:00", days: ["mon"] }] }, savedLooks)).toBe(
      'Office, from 08:00 to 12:00 on Mon, and when the message says "work" or "office"',
    );
    expect(ruleIsReady({ lookId: "l", enabled: true })).toBe(false);
    expect(ruleIsReady({ lookId: "l", enabled: true, keywords: ["x"] })).toBe(true);
    expect(ruleIsReady({ lookId: "l", enabled: true, timeWindows: [{ from: "08:00", to: "" }] })).toBe(false);
    expect(ruleIsReady({ lookId: "l", enabled: true, timeWindows: [{ from: "08:00", to: "08:00" }] })).toBe(false);
    expect(moveRule(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveRule(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
});

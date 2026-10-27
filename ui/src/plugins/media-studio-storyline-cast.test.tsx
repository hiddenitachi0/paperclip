// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShotCastConfirm,
  StorylineCastSection,
  castIdentityOptions,
  type CastIdentityOption,
  type StorylineCast,
} from "../../../packages/plugins/media-studio/src/ui/storyline-cast";
import { ACTION_IDENTITIES_LIST } from "../../../packages/plugins/media-studio/src/ui/anchor-helpers";
import { CAST_IDENTITIES_ACTION } from "../../../packages/plugins/media-studio/src/ui/storyline-cast";

/**
 * Step 1's Cast section of the Storylines editor: link the script's
 * characters to the company's saved people, add characters, and pick who is
 * in each shot. The server is stubbed (fetch).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/companies/c1/video-storylines/s1";

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

function buttonNamed(container: HTMLElement, text: string | RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")));
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

const IDENTITIES: CastIdentityOption[] = [
  { id: "id-maja", name: "Maja Berg", nickname: "Maja", thumbFileId: "face-maja", hasFace: true, hasSogniLora: true },
  { id: "id-noface", name: "Nils", nickname: null, thumbFileId: null, hasFace: false, hasSogniLora: false },
];

const SHOTS = [
  { id: "sh1", orderIndex: 0, prompt: "Maja opens the door", cameraNotes: null },
  { id: "sh2", orderIndex: 1, prompt: "Bo barks at the mailman", cameraNotes: null },
];

describe("StorylineCastSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let onSaved: ReturnType<typeof vi.fn<(storyline: unknown) => Promise<void>>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    calls = [];
    onSaved = vi.fn<(storyline: unknown) => Promise<void>>(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ id: "s1" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function draw(cast: StorylineCast, opts: { sceneNotes?: Array<string | null>; editable?: boolean } = {}) {
    await act(async () => {
      root.render(
        <StorylineCastSection
          base={BASE}
          cast={cast}
          shots={SHOTS}
          sceneNotes={opts.sceneNotes ?? []}
          editable={opts.editable ?? true}
          identities={IDENTITIES}
          onSaved={onSaved}
        />,
      );
    });
    await flush();
  }

  const CAST: StorylineCast = {
    members: [
      { id: "c1", name: "Maja", nickname: null, description: "a woman in her 30s", identityId: null },
      { id: "c2", name: "Bo", nickname: null, description: null, identityId: null },
    ],
    shotCast: {},
  };

  it("explains in plain words what linking does, and lists the characters", async () => {
    await draw(CAST);
    const text = container.textContent ?? "";
    expect(text).toContain("Linking Maja to a saved person keeps Maja's face and body the same in every picture and every shot.");
    expect(container.querySelector('[data-testid="cast-member-c1"]')?.textContent).toContain("a woman in her 30s");
    expect(container.querySelector('[data-testid="cast-picker-c1"]')?.textContent).toContain("Link to a person");
  });

  it("links a character to a saved person picked from a list with thumbnails", async () => {
    await draw(CAST);
    await click(container.querySelector('[data-testid="cast-picker-c1"]')!);
    const list = container.querySelector('[role="listbox"]')!;
    const options = [...list.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual(["Not linked (made from the description only)", 'Maja Berg ("Maja")', "Nils -- no face picture yet"]);
    expect(options[1]!.querySelector("img")?.getAttribute("src")).toBe("/api/attachments/face-maja/thumbnail");
    await click(options[1]!);
    expect(calls).toEqual([
      {
        url: `${BASE}/cast`,
        method: "PUT",
        body: {
          members: [
            { id: "c1", name: "Maja", nickname: null, description: "a woman in her 30s", identityId: "id-maja" },
            { id: "c2", name: "Bo", nickname: null, description: null, identityId: null },
          ],
        },
      },
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("adds a character by hand and the script's characters that are missing", async () => {
    await draw({ members: [], shotCast: {} }, { sceneNotes: ["Characters:\n- Ada: a woman in her 60s\n- Bo: a collie"] });
    expect(container.textContent).toContain("Found in the script but not in the cast yet: Ada, Bo.");
    await click(buttonNamed(container, "Add them"));
    expect(calls[0]!.body).toEqual({
      members: [
        { name: "Ada", nickname: null, description: "a woman in her 60s", identityId: null },
        { name: "Bo", nickname: null, description: "a collie", identityId: null },
      ],
    });
    const name = container.querySelector('input[aria-label="New character name"]') as HTMLInputElement;
    await act(async () => setValue(name, "Cy"));
    await click(buttonNamed(container, "Add character"));
    expect(calls[1]!.body).toEqual({ members: [{ name: "Cy", nickname: null, description: null, identityId: null }] });
  });

  it("shows each shot's suggested cast as chips and saves a change as the person's own pick", async () => {
    await draw({ ...CAST, members: [{ ...CAST.members[0]!, identityId: "id-maja" }, CAST.members[1]!] });
    const row1 = container.querySelector('[data-testid="shot-cast-row-sh1"]')!;
    const chips = [...row1.querySelectorAll("button[aria-pressed]")] as HTMLButtonElement[];
    expect(chips.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(row1.textContent).toContain("Suggested");
    await click(chips[1]!);
    expect(calls[0]).toEqual({ url: `${BASE}/shots/sh1/cast`, method: "PUT", body: { castIds: ["c1", "c2"] } });
  });

  it("confirms the suggested cast for one shot", async () => {
    await draw(CAST);
    await click(container.querySelector('[data-testid="confirm-cast-sh1"]')!);
    expect(calls).toEqual([{ url: `${BASE}/shots/sh1/cast`, method: "PUT", body: { castIds: ["c1"] } }]);
    expect(container.textContent).toContain("Confirmed the cast for shot 1.");
  });

  it("confirms the suggested cast for all shots with one click when nothing is ticked yet (shotCast is empty)", async () => {
    await draw(CAST);
    expect(container.textContent).toContain("2 shots are still waiting for you to confirm.");
    await click(container.querySelector('[data-testid="confirm-all-cast"]')!);
    expect(calls).toEqual([
      { url: `${BASE}/shots/sh1/cast`, method: "PUT", body: { castIds: ["c1"] } },
      { url: `${BASE}/shots/sh2/cast`, method: "PUT", body: { castIds: ["c2"] } },
    ]);
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Confirmed the cast for 2 shots.");
  });

  it("only confirms the shots that are not confirmed yet, and shows when all are", async () => {
    await draw({ ...CAST, shotCast: { sh1: ["c1"] } });
    await click(container.querySelector('[data-testid="confirm-all-cast"]')!);
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/shots/sh2/cast`]);
    await draw({ ...CAST, shotCast: { sh1: ["c1"], sh2: ["c2"] } });
    expect(container.querySelector('[data-testid="confirm-all-cast"]')).toBeNull();
    expect(container.querySelector('[data-testid="all-cast-confirmed"]')?.textContent).toContain("confirmed for every shot");
  });

  it("goes back to the description for a confirmed shot", async () => {
    await draw({ ...CAST, shotCast: { sh2: [] } });
    const row2 = container.querySelector('[data-testid="shot-cast-row-sh2"]')!;
    expect(([...row2.querySelectorAll("button[aria-pressed]")] as HTMLButtonElement[]).map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
    await click(buttonNamed(row2 as HTMLElement, "Use the description"));
    expect(calls[0]).toEqual({ url: `${BASE}/shots/sh2/cast`, method: "PUT", body: { castIds: null } });
  });

  it("shows the server's refusal in plain words and says how far a bulk confirm got", async () => {
    const refusal = "That character is not in this storyline's cast any more. Refresh the page and pick again.";
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        return n === 1
          ? new Response(JSON.stringify({ id: "s1" }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: refusal }), { status: 422, headers: { "content-type": "application/json" } });
      }),
    );
    await draw(CAST);
    await click(container.querySelector('[data-testid="confirm-all-cast"]')!);
    const alert = container.querySelector('[data-testid="shot-cast-error"]')!;
    expect(alert.textContent).toContain(refusal);
    expect(alert.textContent).toContain("1 of 2 shots were confirmed before this stopped.");
  });

  it("tells people about characters without a linked person", async () => {
    const onLinkPerson = vi.fn();
    await act(async () => {
      root.render(<ShotCastConfirm base={BASE} cast={CAST} shots={SHOTS} identities={IDENTITIES} editable onSaved={onSaved} onLinkPerson={onLinkPerson} />);
    });
    await flush();
    expect(container.querySelector('[data-testid="cast-unlinked-note"]')?.textContent).toContain("Maja, Bo are not linked to a person");
    await click(buttonNamed(container, "Link to a person"));
    expect(onLinkPerson).toHaveBeenCalledTimes(1);
  });

  it("warns plainly when a shot has two saved people, and when a saved person has no face picture", async () => {
    await draw({
      members: [
        { id: "c1", name: "Maja", nickname: null, description: null, identityId: "id-maja" },
        { id: "c2", name: "Bo", nickname: null, description: null, identityId: "id-noface" },
      ],
      shotCast: { sh2: ["c1", "c2"] },
    });
    expect(container.textContent).toContain("One shot has more than one saved person.");
    expect(container.querySelector('[data-testid="cast-member-c2"]')?.textContent).toContain("has no face picture yet");
    expect(container.querySelector('[data-testid="cast-member-c1"]')?.textContent).toContain("Has a trained LoRA");
  });

  it("cannot be changed while the video is rendering", async () => {
    await draw(CAST, { editable: false });
    expect(container.textContent).toContain("The cast cannot be changed while the video is rendering.");
    expect((container.querySelector('[data-testid="cast-picker-c1"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('input[aria-label="New character name"]')).toBeNull();
  });
});

describe("cast helpers", () => {
  it("reads the plugin's identities list: face crop as the thumbnail, a ready Sogni LoRA", () => {
    expect(
      castIdentityOptions({
        identities: [
          {
            id: "i1",
            name: "Maja",
            nickname: "",
            crops: [{ role: "body", fileId: "b" }, { role: "face", fileId: "f" }],
            canonicalFileId: "canon",
            trainedIdentities: [{ provider: "sogni-lora", status: "ready" }],
          },
          { id: "i2", name: "Nils", crops: [], canonicalFileId: "canon2" },
          { name: "broken" },
        ],
      }),
    ).toEqual([
      { id: "i1", name: "Maja", nickname: null, thumbFileId: "f", hasFace: true, hasSogniLora: true },
      { id: "i2", name: "Nils", nickname: null, thumbFileId: "canon2", hasFace: true, hasSogniLora: false },
    ]);
  });

  it("uses the same action name as the Identities tab", () => {
    expect(CAST_IDENTITIES_ACTION).toBe(ACTION_IDENTITIES_LIST);
  });
});

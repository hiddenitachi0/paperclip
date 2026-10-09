// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    expect(container.querySelector('[data-testid="cast-picker-c1"]')?.textContent).toContain("Not linked");
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

  it("shows who is in each shot from the names, and saves a person's own pick or goes back to the names", async () => {
    await draw({ ...CAST, members: [{ ...CAST.members[0]!, identityId: "id-maja" }, CAST.members[1]!] });
    const row1 = container.querySelector('[data-testid="shot-cast-row-sh1"]')!;
    const boxes = [...row1.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(row1.textContent).toContain("found by name");
    await click(boxes[1]!);
    expect(calls[0]).toEqual({ url: `${BASE}/shots/sh1/cast`, method: "PUT", body: { castIds: ["c1", "c2"] } });

    await draw({ ...CAST, shotCast: { sh2: [] } });
    const row2 = container.querySelector('[data-testid="shot-cast-row-sh2"]')!;
    expect(([...row2.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]).map((b) => b.checked)).toEqual([false, false]);
    await click(buttonNamed(row2 as HTMLElement, "Use the description"));
    expect(calls[1]).toEqual({ url: `${BASE}/shots/sh2/cast`, method: "PUT", body: { castIds: null } });
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

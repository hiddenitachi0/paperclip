// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContentRatingBadge,
  ContentRatingSwitch,
  readFilmRating,
  refusalText,
  useFilmRatingAccess,
  type FilmRatingAccess,
} from "../../../packages/plugins/media-studio/src/ui/storyline-rating";

/**
 * The "Safe for work" / "Mature" badge on a film and the owner-only switch in
 * its header. The server is stubbed (fetch).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = "/api/companies/c1/video-storylines/s1";
const OWNER: FilmRatingAccess = { ready: true, canMakeMature: true, canMakeSafe: true };
const ADMIN: FilmRatingAccess = { ready: true, canMakeMature: false, canMakeSafe: true };
const VIEWER: FilmRatingAccess = { ready: true, canMakeMature: false, canMakeSafe: false };

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("content rating badge", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says Safe for work for a safe, missing or unreadable rating, and Mature only for mature", async () => {
    expect(readFilmRating("mature")).toBe("mature");
    for (const value of ["sfw", undefined, null, "anything"]) expect(readFilmRating(value)).toBe("sfw");
    await act(async () => root.render(<ContentRatingBadge rating="mature" />));
    expect(container.textContent).toBe("Mature");
    await act(async () => root.render(<ContentRatingBadge rating={undefined} />));
    expect(container.textContent).toBe("Safe for work");
    expect(container.querySelector('[data-testid="content-rating-badge"]')?.getAttribute("data-rating")).toBe("sfw");
  });
});

describe("ContentRatingSwitch", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let respond: () => Response;
  let onChanged: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    calls = [];
    respond = () => json({ id: "s1" });
    onChanged = vi.fn<() => Promise<void>>(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
        return respond();
      }),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function draw(rating: string, access: FilmRatingAccess) {
    await act(async () => {
      root.render(<ContentRatingSwitch base={BASE} rating={rating} access={access} onChanged={onChanged} />);
    });
    await flush();
  }

  it("shows no switch to people who may not change the rating", async () => {
    await draw("sfw", VIEWER);
    expect(container.querySelector('[data-testid="content-rating-switch"]')).toBeNull();
    await draw("mature", VIEWER);
    expect(container.querySelector('[data-testid="content-rating-switch"]')).toBeNull();
    await draw("sfw", { ...OWNER, ready: false });
    expect(container.querySelector('[data-testid="content-rating-switch"]')).toBeNull();
  });

  it("lets a company admin switch a Mature film back, but not make a film Mature", async () => {
    await draw("sfw", ADMIN);
    expect(container.querySelector('[data-testid="content-rating-switch"]')).toBeNull();
    await draw("mature", ADMIN);
    expect(buttonNamed(container, "Switch back to Safe for work")).toBeTruthy();
  });

  it("asks first, in plain words, before making a film Mature, and sends the yes", async () => {
    await draw("sfw", OWNER);
    await click(buttonNamed(container, "Switch to Mature…"));
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Allow mature content in this film?");
    expect(dialog.textContent).toContain("only turned off for looks that were saved as mature");
    expect(dialog.textContent).toContain("Some models that are blocked in a Safe for work film can be used");
    expect(calls).toHaveLength(0);

    await click(buttonNamed(container, "Yes, make it Mature"));
    expect(calls).toEqual([{ url: `${BASE}/content-rating`, method: "PUT", body: { contentRating: "mature", confirmed: true } }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("sends nothing when the dialog is cancelled", async () => {
    await draw("sfw", OWNER);
    await click(buttonNamed(container, "Switch to Mature…"));
    await click(buttonNamed(container, "Cancel"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("switches back to Safe for work without a dialog", async () => {
    await draw("mature", OWNER);
    await click(buttonNamed(container, "Switch back to Safe for work"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(calls).toEqual([{ url: `${BASE}/content-rating`, method: "PUT", body: { contentRating: "sfw" } }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows the server's own sentence inside the dialog when it refuses, and keeps the film as it was", async () => {
    respond = () => json({ error: "Only the company's owner or an administrator for the whole Paperclip instance can view and change a film's content rating." }, 403);
    await draw("sfw", OWNER);
    await click(buttonNamed(container, "Switch to Mature…"));
    await click(buttonNamed(container, "Yes, make it Mature"));
    const alert = container.querySelector('[role="dialog"] [role="alert"]')!;
    expect(alert.textContent).toBe("Only the company's owner or an administrator for the whole Paperclip instance can view and change a film's content rating.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("shows the server's refusal when switching back is refused", async () => {
    respond = () => json({ error: "An agent can't change what a film may show. The company's owner can do it from the film's header." }, 403);
    await draw("mature", OWNER);
    await click(buttonNamed(container, "Switch back to Safe for work"));
    expect(container.querySelector('[data-testid="content-rating-error"]')?.textContent).toContain("An agent can't change what a film may show.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("strips only the generic 'no access' prefix from a refusal", () => {
    expect(refusalText(new Error("You don't have access to do that: Only owners."))).toBe("Only owners.");
    expect(refusalText(new Error("Switching a film to mature needs a yes from you first."))).toBe("Switching a film to mature needs a yes from you first.");
    expect(refusalText("nope")).toBe("The change was not saved. Please try again.");
  });
});

function AccessProbe(props: { companyId: string; userId: string | null }) {
  const access = useFilmRatingAccess(props.companyId, props.userId);
  return <div data-testid="probe">{JSON.stringify(access)}</div>;
}

describe("useFilmRatingAccess", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  let nextUser = 0;
  async function accessFor(me: unknown, userId: string | null = `u${(nextUser += 1)}`) {
    vi.stubGlobal("fetch", vi.fn(async () => json(me)));
    // A new user id each time, so the hook asks again.
    await act(async () => root.render(<AccessProbe companyId="c1" userId={userId} />));
    await flush();
    return JSON.parse(container.querySelector('[data-testid="probe"]')!.textContent!) as FilmRatingAccess;
  }

  it("lets the owner and an instance admin do both, a company admin only switch back, and others nothing", async () => {
    expect(await accessFor({ memberships: [{ companyId: "c1", membershipRole: "owner", status: "active" }] })).toEqual(OWNER);
    expect(await accessFor({ isInstanceAdmin: true, memberships: [] })).toEqual(OWNER);
    expect(await accessFor({ memberships: [{ companyId: "c1", membershipRole: "admin", status: "active" }] })).toEqual(ADMIN);
    expect(await accessFor({ memberships: [{ companyId: "c1", membershipRole: "operator", status: "active" }] })).toEqual(VIEWER);
    expect(await accessFor({ memberships: [{ companyId: "c1", membershipRole: "owner", status: "suspended" }] })).toEqual(VIEWER);
    expect(await accessFor({ memberships: [{ companyId: "other", membershipRole: "owner", status: "active" }] })).toEqual(VIEWER);
  });

  it("treats a single-user Paperclip without sign-in as the owner", async () => {
    expect(await accessFor({}, null)).toEqual(OWNER);
  });

  it("shows no switch when the sign-in check fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "boom" }, 500)));
    await act(async () => root.render(<AccessProbe companyId="c1" userId="u1" />));
    await flush();
    expect(JSON.parse(container.querySelector('[data-testid="probe"]')!.textContent!)).toEqual(VIEWER);
  });
});

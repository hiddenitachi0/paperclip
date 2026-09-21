// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CrossCompanyAccessLogEntry, CrossCompanyAccessLogPage } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { describeWho, InstanceCrossCompanyAccess, startOfNextLocalDay } from "./InstanceCrossCompanyAccess";

const mockApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/crossCompanyAccess", () => ({ crossCompanyAccessApi: mockApi }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

function entry(overrides: Partial<CrossCompanyAccessLogEntry> = {}): CrossCompanyAccessLogEntry {
  return {
    id: "e1",
    occurredAt: "2026-09-18T12:00:00.000000Z",
    reason: "board identity/session summary spans all of a user's company memberships",
    actorType: "user",
    actorId: "user-filip",
    actorName: "Filip",
    route: "/cli-auth/me",
    companies: [],
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function findButton(container: HTMLElement, text: string) {
  return (Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) ??
    null) as HTMLButtonElement | null;
}

describe("describeWho", () => {
  it("says who did it in plain words", () => {
    expect(describeWho({ actorType: "user", actorId: "u1", actorName: "Filip" })).toBe("Filip");
    expect(describeWho({ actorType: "agent", actorId: "a1", actorName: "Fork Lead" })).toBe("Agent Fork Lead");
    expect(describeWho({ actorType: "agent", actorId: "a1", actorName: null })).toBe("An agent");
    expect(describeWho({ actorType: "scheduler", actorId: null, actorName: null })).toBe(
      "Paperclip's background scheduler",
    );
    expect(describeWho({ actorType: null, actorId: null, actorName: null })).toBe("Someone who was not signed in yet");
  });
});

describe("startOfNextLocalDay", () => {
  it("includes the whole 'to' day", () => {
    const start = new Date(startOfNextLocalDay("2026-09-18")!);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8);
    expect(start.getDate()).toBe(19);
    expect(start.getHours()).toBe(0);
  });
});

describe("InstanceCrossCompanyAccess page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderPage() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <InstanceCrossCompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.list.mockReset();
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root!.unmount());
      root = null;
    }
    container.remove();
  });

  it("lists entries and pages older and back to newer with the server's cursor", async () => {
    const firstPage: CrossCompanyAccessLogPage = {
      entries: [
        entry({ companies: [{ id: "c1", name: "Nordstrand Gruppen" }, { id: "c2", name: null }] }),
      ],
      nextCursor: "cursor-1",
    };
    const secondPage: CrossCompanyAccessLogPage = {
      entries: [entry({ id: "e2", actorType: "scheduler", actorId: null, actorName: null, reason: "restart recovery" })],
      nextCursor: null,
    };
    mockApi.list.mockImplementation(async (query: { cursor?: string | null }) =>
      query.cursor === "cursor-1" ? secondPage : firstPage,
    );
    await renderPage();

    expect(container.textContent).toContain("Who looked at another company's data");
    expect(container.textContent).toContain("Filip");
    expect(container.textContent).toContain("Nordstrand Gruppen");
    expect(container.textContent).toContain("a company that no longer exists");
    expect(mockApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: null, from: null, to: null, showRoutine: false }),
    );
    expect(findButton(container, "Newer")?.disabled).toBe(true);

    flushSync(() => findButton(container, "Older")!.click());
    await flushReact();
    expect(mockApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "cursor-1" }));
    expect(container.textContent).toContain("Paperclip's background scheduler");
    expect(container.textContent).toContain("Page 2");
    expect(findButton(container, "Older")?.disabled).toBe(true);

    flushSync(() => findButton(container, "Newer")!.click());
    await flushReact();
    expect(container.textContent).toContain("Page 1");
    expect(container.textContent).toContain("Filip");
  });

  it("tells a non-admin plainly that the page is for the instance admin", async () => {
    mockApi.list.mockRejectedValue(new ApiError("Instance admin access required", 403, {}));
    await renderPage();
    expect(container.textContent).toContain("Only an instance admin can see this page.");
    expect(container.querySelectorAll('[data-testid="cross-company-access-row"]')).toHaveLength(0);
  });
});

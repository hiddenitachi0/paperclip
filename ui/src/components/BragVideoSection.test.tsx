// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BragJob } from "../api/bragVideos";
import { BragVideoSection } from "./BragVideoSection";

const mockApi = vi.hoisted(() => ({
  list: vi.fn(),
  estimate: vi.fn(),
  create: vi.fn(),
  updateScene: vi.fn(),
  startRender: vi.fn(),
}));
vi.mock("../api/bragVideos", () => ({ bragVideosApi: mockApi }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <BragVideoSection companyId="c1" projectId="p1" />
      </QueryClientProvider>,
    );
  });
  await flush();
}

const job = (over: Partial<BragJob>): BragJob => ({
  id: "j1", projectId: "p1", status: "completed", sourceUrl: null, tone: "Confident", format: "landscape",
  lengthSeconds: 20, music: false, note: null, estimatedCostCents: 250, actualCostCents: 0,
  videoUrl: null, posterUrl: null, shareCopy: null, failureReason: null, scenes: [],
  createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", ...over,
});

const button = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("BragVideoSection", () => {
  it("shows the price, then creates a job with the chosen options", async () => {
    mockApi.list.mockResolvedValue([]);
    mockApi.estimate.mockResolvedValue({ estimatedCostCents: 250 });
    mockApi.create.mockResolvedValue(job({ status: "planning" }));
    await render();
    expect(document.body.textContent).toContain("No video yet");
    await act(async () => button("Make a launch video")!.click());
    await flush();
    expect(document.body.textContent).toContain("$2.50");
    await act(async () => button("Tall")!.click());
    await flush();
    await act(async () => button("Start")!.click());
    expect(mockApi.create).toHaveBeenCalledWith("c1", "p1", expect.objectContaining({
      format: "vertical", tone: "Confident", music: false, lengthSeconds: 20, sourceUrl: null,
    }));
  });

  it("blocks Start and says so when the price cannot be worked out", async () => {
    mockApi.list.mockResolvedValue([]);
    mockApi.estimate.mockRejectedValue(new Error("Price service is down"));
    await render();
    await act(async () => button("Make a launch video")!.click());
    await flush();
    expect(document.body.textContent).toContain("Price service is down");
    expect(button("Start")!.disabled).toBe(true);
  });

  it("only allows making the video once every kept scene is approved", async () => {
    mockApi.list.mockResolvedValue([
      job({ status: "awaiting_approval", scenes: [
        { id: "s1", sceneOrder: 0, description: "Intro", stillUrl: null, approvalStatus: "approved" },
        { id: "s2", sceneOrder: 1, description: "Dashboard", stillUrl: null, approvalStatus: "pending" },
      ] }),
    ]);
    await render();
    expect(button("Make the video")!.disabled).toBe(true);
    await act(async () => Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Approve")!.click());
    expect(mockApi.updateScene).toHaveBeenCalledWith("c1", "p1", "j1", "s2", { approvalStatus: "approved" });
  });

  it("shows the failure reason instead of hiding it", async () => {
    mockApi.list.mockResolvedValue([job({ status: "failed", failureReason: "The website could not be reached." })]);
    await render();
    expect(document.body.textContent).toContain("The website could not be reached.");
  });

  it("shows the player and share text when finished", async () => {
    mockApi.list.mockResolvedValue([job({ videoUrl: "/v.mp4", shareCopy: "Look what we built" })]);
    await render();
    expect(document.body.querySelector("video")).not.toBeNull();
    expect(document.body.textContent).toContain("Look what we built");
    expect(button("Make another")).toBeDefined();
    expect(button("Change the tone")).toBeDefined();
  });
});

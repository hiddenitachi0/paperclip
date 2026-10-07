// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeDifference, describeOp, ModelReviewPanel } from "./ModelReviewPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ listReviews: vi.fn(), runReview: vi.fn(), decideChange: vi.fn() }));
vi.mock("../api/modelDirectory", () => ({ modelDirectoryApi: api }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

const base = { thinking: null, ops: [] };
const settings = (t: "on" | "off" | null) => ({ defaultThinking: t, defaultTemperature: null, defaultMaxOutputTokens: null });
const change = (id: string, status: string, extra = {}) => ({
  id,
  code: "qwen_empty_thinking",
  title: `Fix ${id}`,
  why: "Some answers came back empty.",
  status,
  dropsCapability: false,
  before: { settings: settings(null), ops: [] },
  after: { settings: settings("off"), ops: [{ op: "strip_output_wrapper", wrapper: "think" }] },
  decidedAt: null,
  ...extra,
});
const review = (changes: unknown[]) => ({
  id: "r1",
  entryId: "e1",
  trigger: "manual",
  createdAt: "2026-10-06T10:00:00Z",
  report: {
    summary: "Chat 60/100.",
    scores: { chat: 60, tools: 0, pictures: null, speed: null },
    findings: [{ code: "x", text: "Tools did not work." }],
    probes: {},
  },
  changes,
});

let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  container.remove();
  vi.clearAllMocks();
});

async function mount(canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ModelReviewPanel companyId="c1" entryId="e1" canManage={canManage} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}
const click = async (el: Element | null) => {
  await act(async () => {
    (el as HTMLElement).click();
  });
};
const buttonByText = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;

describe("ModelReviewPanel", () => {
  it("explains the empty state", async () => {
    api.listReviews.mockResolvedValue([]);
    await mount();
    expect(container.textContent).toContain("has not been checked yet");
    expect(buttonByText("Check this model")).not.toBeNull();
  });

  it("shows scores, findings, and a pending card that can be applied", async () => {
    api.listReviews.mockResolvedValue([review([change("c1", "proposed", { dropsCapability: true })])]);
    api.decideChange.mockResolvedValue(review([]));
    await mount();
    expect(container.textContent).toContain("60 out of 100");
    expect(container.textContent).toContain("Not tested");
    expect(container.textContent).toContain("Tools did not work.");
    expect(container.textContent).toContain("needs your yes");
    expect(container.textContent).toContain("Thinking: the model's own choice  →  Thinking: off");
    await click(buttonByText("Apply this fix"));
    expect(api.decideChange).toHaveBeenCalledWith("c1", "e1", "r1", "c1", "apply");
  });

  it("offers one-click undo for an applied fix", async () => {
    api.listReviews.mockResolvedValue([review([change("c2", "applied")])]);
    api.decideChange.mockResolvedValue(review([]));
    await mount();
    await click(buttonByText("Show past fixes"));
    await click(buttonByText("Undo this fix"));
    expect(api.decideChange).toHaveBeenCalledWith("c1", "e1", "r1", "c2", "undo");
  });

  it("hides the action buttons from people who cannot manage", async () => {
    api.listReviews.mockResolvedValue([review([change("c1", "proposed"), change("c2", "applied")])]);
    await mount(false);
    expect(buttonByText("Apply this fix")).toBeNull();
    expect(buttonByText("Check again")).toBeNull();
    expect(container.textContent).toContain("Only the company owner or an admin can decide");
  });
});

describe("plain wording helpers", () => {
  it("describes ops without internal names", () => {
    expect(describeOp({ op: "strip_output_wrapper", wrapper: "think" })).toContain("private thinking");
    expect(describeOp({ op: "parse_text_tool_call" })).not.toMatch(/parse|_/);
  });
  it("lists only what differs", () => {
    expect(describeDifference({ settings: settings("off"), ops: [] }, { settings: settings("off"), ops: [] })).toEqual([]);
  });
});

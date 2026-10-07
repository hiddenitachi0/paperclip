// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BragVideoDialog } from "./BragVideoDialog";

const mockApi = vi.hoisted(() => ({ estimate: vi.fn(), createJob: vi.fn(), planJob: vi.fn(), updateScene: vi.fn(), render: vi.fn() }));
vi.mock("../api/brag", () => ({
  bragApi: mockApi,
  bragSceneStillPath: (companyId: string, jobId: string, sceneId: string) => `/api/companies/${companyId}/brag/jobs/${jobId}/scenes/${sceneId}/still/content`,
  bragFilePath: (fileId: string) => `/api/attachments/${fileId}/content`,
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const scene = (approvalStatus: string) => ({ id: "s1", jobId: "j1", sceneOrder: 1, description: "Home page", approvalStatus, stillRef: "k/a1" });
const job = (status = "awaiting_approval") => ({
  id: "j1",
  projectId: "p1",
  status,
  format: "landscape",
  lengthSeconds: 20,
  music: false,
  estimatedCostCents: 15,
  actualCostCents: 0,
  sourceUrl: null,
  tone: "hype",
  note: null,
  options: {},
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
function click(label: string) {
  const b = Array.from(document.body.querySelectorAll("button")).find((x) => x.textContent?.trim() === label) as HTMLButtonElement;
  expect(b, label).toBeTruthy();
  return act(async () => { b.click(); });
}

describe("BragVideoDialog", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mockApi.estimate.mockResolvedValue({ estimatedCostCents: 15, sceneCount: 5, planningCents: 15, musicCents: 0 });
    mockApi.createJob.mockResolvedValue({ ...job("draft"), id: "j1" });
    mockApi.planJob.mockResolvedValue({ job: job("awaiting_approval"), scenes: [scene("pending")] });
    mockApi.updateScene.mockResolvedValue([scene("approved")]);
    mockApi.render.mockResolvedValue({
      job: { ...job("completed"), options: { videoFileId: "v1", posterFileId: "p1", shareCopy: "We just made something new!" } },
      scenes: [scene("approved")],
    });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

  it("shows the price, then pictures, then the finished video", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <BragVideoDialog open onOpenChange={() => {}} companyId="c1" projectId="p1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(document.body.textContent).toContain("about $0.15");
    await click("Show me the pictures");
    await flush();
    expect(mockApi.createJob).toHaveBeenCalledWith("c1", expect.objectContaining({ projectId: "p1", format: "landscape", lengthSeconds: 20, music: false, sourceUrl: undefined }));
    expect(mockApi.planJob).toHaveBeenCalledWith("c1", "j1");
    expect(document.body.textContent).toContain("Home page");
    expect((Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Make the video") as HTMLButtonElement).disabled).toBe(true);
    await click("Approve");
    await flush();
    await click("Make the video");
    await flush();
    expect(mockApi.render).toHaveBeenCalledWith("c1", "j1");
    expect(document.body.querySelector("video")?.getAttribute("src")).toBe("/api/attachments/v1/content");
    expect((document.getElementById("brag-share") as HTMLTextAreaElement).value).toBe("We just made something new!");
  });

  it("shows a clear message when the pictures cannot be prepared", async () => {
    mockApi.createJob.mockRejectedValue(new Error("boom"));
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <BragVideoDialog open onOpenChange={() => {}} companyId="c1" projectId="p1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    await click("Show me the pictures");
    await flush();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Could not start the video");
  });
});

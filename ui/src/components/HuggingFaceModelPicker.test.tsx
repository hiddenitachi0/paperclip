// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceModelPicker } from "./HuggingFaceModelPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockApi = vi.hoisted(() => ({ huggingFaceModels: vi.fn() }));
vi.mock("../api/laneA", () => ({ laneAApi: mockApi }));

const h = (provider: string, tools: boolean, i: number) => ({
  provider, status: "live", supportsTools: tools, supportsStructuredOutput: false, contextLength: 32000,
  inputUsdPerMillion: i, outputUsdPerMillion: i, firstTokenLatencyMs: null, throughput: null,
});
const models = [
  { id: "Qwen/Qwen3-14B", providers: [h("deepinfra", true, 0.1), h("novita", false, 0.05)] },
  { id: "meta-llama/Llama-3", providers: [h("novita", false, 0.05)] },
];

let container: HTMLDivElement;
async function render(value: string | null, onSave = vi.fn()) {
  mockApi.huggingFaceModels.mockResolvedValue({ models });
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <HuggingFaceModelPicker companyId="c1" value={value} onSave={onSave} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 10 && container.textContent?.includes("Loading"); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  return onSave;
}
afterEach(() => { container?.remove(); vi.clearAllMocks(); });

describe("HuggingFaceModelPicker", () => {
  it("hides no-tools models by default and shows them when the filter is cleared", async () => {
    await render(null);
    expect(container.textContent).toContain("Qwen/Qwen3-14B");
    expect(container.textContent).not.toContain("meta-llama/Llama-3");
    await act(async () => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(container.textContent).toContain("meta-llama/Llama-3");
  });
  it("saves model:host when a host is picked", async () => {
    const onSave = await render(null);
    await act(async () => { container.querySelector<HTMLButtonElement>("ul button")!.click(); });
    const use = [...container.querySelectorAll("button")].find((b) => b.textContent === "Use this host")!;
    await act(async () => { use.click(); });
    expect(onSave).toHaveBeenCalledWith("Qwen/Qwen3-14B:deepinfra");
  });
  it("shows the no-tools message only for a host without tools", async () => {
    await render("Qwen/Qwen3-14B:novita");
    expect(container.querySelector('[data-testid="huggingface-no-tools-warning"]')).not.toBeNull();
    container.remove();
    await render("Qwen/Qwen3-14B:deepinfra");
    expect(container.querySelector('[data-testid="huggingface-no-tools-warning"]')).toBeNull();
  });
});

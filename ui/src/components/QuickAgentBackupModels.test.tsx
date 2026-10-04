// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneABackupModelConfig, LaneAKeywordRoute, LaneAProvider } from "@paperclipai/shared";
import { QuickAgentBackupModels } from "./QuickAgentBackupModels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Saved = {
  backups?: LaneABackupModelConfig[];
  noAnswerChainIds?: string[];
  refusalChainIds?: string[];
  keywordRoutes?: LaneAKeywordRoute[];
};

const claudeMain: { provider: LaneAProvider; baseUrl: string | null; hasKey: boolean } = { provider: "openai", baseUrl: null, hasKey: true };

describe("QuickAgentBackupModels", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSave = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onSave.mockReset();
    onSave.mockResolvedValue({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(saved: Saved = {}, main = claudeMain, disabled = false) {
    act(() => {
      root.render(<QuickAgentBackupModels saved={saved} main={main} disabled={disabled} onSave={onSave} />);
    });
  }
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = (el: Element | null) => {
    if (!el) throw new Error("element not found");
    act(() => {
      (el as HTMLElement).click();
    });
  };
  const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  const change = (el: HTMLElement | null, value: string) => {
    if (!el) throw new Error("element not found");
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  };

  const entry = (id: string, model: string, provider: LaneABackupModelConfig["provider"] = "anthropic") =>
    ({ id, provider, model }) as LaneABackupModelConfig;

  it("adds up to five backups and then refuses a sixth", () => {
    render();
    expect(q("backup-empty")).not.toBeNull();
    for (let i = 0; i < 5; i += 1) click(q("backup-add"));
    expect(container.querySelectorAll('[data-testid^="backup-entry-"]').length).toBe(5);
    expect((q("backup-add") as HTMLButtonElement).disabled).toBe(true);
    expect(q("backup-limit")?.textContent).toContain("most you can add (5)");
    click(q("backup-add"));
    expect(container.querySelectorAll('[data-testid^="backup-entry-"]').length).toBe(5);
  });

  it("reorders backups", () => {
    render({ backups: [entry("a", "gpt-4.1-mini", "openai"), entry("b", "gpt-4.1", "openai")] });
    expect((q("backup-model-0") as HTMLSelectElement).value).toBe("gpt-4.1-mini");
    click(byLabel("Move backup 1 down"));
    expect((q("backup-model-0") as HTMLSelectElement).value).toBe("gpt-4.1");
    expect(byLabel("Move backup 1 up")!.disabled).toBe(true);
  });

  it("removes a backup and everything that pointed at it", () => {
    render({
      backups: [entry("a", "gpt-4.1-mini", "openai"), entry("b", "gpt-4.1", "openai")],
      noAnswerChainIds: ["a", "b"],
      refusalChainIds: ["a"],
      keywordRoutes: [{ id: "r", phrases: ["refund"], backupId: "a" }],
    });
    click(byLabel("Remove backup 1"));
    expect(container.querySelectorAll('[data-testid^="backup-entry-"]').length).toBe(1);
    expect(q("backup-route-0")).toBeNull();
    click(q("backup-save"));
    const patch = onSave.mock.calls[0]![0];
    expect(patch.laneABackupModels.map((e: { id: string }) => e.id)).toEqual(["b"]);
    expect(patch.laneANoAnswerChainIds).toEqual(["b"]);
    expect(patch.laneARefusalChainIds).toEqual([]);
    expect(patch.laneAKeywordRoutes).toEqual([]);
  });

  it("says what is wrong instead of saving a local backup with no address", () => {
    render({ backups: [entry("a", "llama3.1", "local")] });
    change(q("backup-model-0"), "llama3.1x");
    click(q("backup-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(q("backup-problems")?.textContent).toContain("Backup 1: Add an address");
  });

  it("saves the two lists and a keyword rule together", () => {
    render({ backups: [entry("a", "gpt-4.1-mini", "openai"), entry("b", "gpt-4.1", "openai")] });
    change(q("backup-chain-no-answer-add"), "b");
    change(q("backup-chain-refusal-add"), "a");
    click(q("backup-route-add"));
    change(q("backup-route-phrases-0"), "refund, Refund, invoice");
    change(q("backup-route-target-0"), "b");
    click(q("backup-save"));
    const patch = onSave.mock.calls[0]![0];
    expect(patch.laneANoAnswerChainIds).toEqual(["b"]);
    expect(patch.laneARefusalChainIds).toEqual(["a"]);
    expect(patch.laneAKeywordRoutes).toHaveLength(1);
    expect(patch.laneAKeywordRoutes[0].phrases).toEqual(["refund", "invoice"]);
    expect(patch.laneAKeywordRoutes[0].backupId).toBe("b");
  });

  it("test button reports a missing key and a ready backup in plain words", () => {
    render({ backups: [entry("a", "gpt-4.1-mini", "openai"), entry("b", "claude-sonnet-5")] }, { provider: "anthropic", baseUrl: null, hasKey: false });
    click(q("backup-test-0"));
    expect(q("backup-test-result-0")?.textContent).toContain("No key to use");
    click(q("backup-test-1"));
    expect(q("backup-test-result-1")?.textContent).toContain("Ready");
  });

  it("a backup on the main model's provider borrows the main key", () => {
    render(
      { backups: [entry("a", "gpt-4.1-mini", "openai")] },
      { provider: "openai", baseUrl: null, hasKey: true },
    );
    click(q("backup-test-0"));
    expect(q("backup-test-result-0")?.textContent).toContain("same OpenAI key");
  });

  it("hides editing controls when the person cannot edit", () => {
    render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, true);
    expect(q("backup-save")).toBeNull();
    expect((q("backup-add") as HTMLButtonElement).disabled).toBe(true);
  });
});

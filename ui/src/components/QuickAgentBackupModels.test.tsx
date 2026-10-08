// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneABackupModelConfig, LaneAKeywordRoute, LaneAProvider, ModelDirectoryEntry } from "@paperclipai/shared";
import { backupFieldsFromDirectoryEntry, QuickAgentBackupModels } from "./QuickAgentBackupModels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Saved = {
  backups?: LaneABackupModelConfig[];
  noAnswerChainIds?: string[];
  refusalChainIds?: string[];
  keywordRoutes?: LaneAKeywordRoute[];
};

const claudeMain: { provider: LaneAProvider; baseUrl: string | null; hasKey: boolean } = { provider: "openai", baseUrl: null, hasKey: true };

function savedModel(overrides: Partial<ModelDirectoryEntry> = {}): ModelDirectoryEntry {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "Mistral via OpenRouter",
    provider: "openrouter",
    model: "mistralai/mistral-small-3.2-24b-instruct",
    baseUrl: null,
    providerRouting: { only: ["deepinfra"] },
    defaultThinking: "off",
    defaultTemperature: 0.7,
    defaultMaxOutputTokens: 1024,
    backupEntryIds: [],
    note: null,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}
const MISTRAL = savedModel();
const OLLAMA = savedModel({
  id: "44444444-4444-4444-8444-444444444444",
  name: "Qwen on my PC",
  provider: "local",
  model: "qwen3:14b",
  baseUrl: "http://100.1.2.3:11434/v1",
  providerRouting: null,
  defaultTemperature: null,
});

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

  function render(saved: Saved = {}, main = claudeMain, disabled = false, savedModels?: ModelDirectoryEntry[]) {
    act(() => {
      root.render(
        <QuickAgentBackupModels saved={saved} main={main} disabled={disabled} savedModels={savedModels} onSave={onSave} />,
      );
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

  describe("saved models", () => {
    const value = (id: string) => (q(id) as HTMLInputElement | HTMLSelectElement | null)?.value;

    it("offers no saved-model picker when the company has none", () => {
      render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, false, []);
      expect(q("backup-saved-model-0")).toBeNull();
      expect(q("backup-add-saved")).toBeNull();
      expect(q("backup-add")?.textContent).toBe("Add a backup");
    });

    it("lists the saved models on every backup, starting on Custom", () => {
      render(
        { backups: [entry("a", "gpt-4.1-mini", "openai"), entry("b", "gpt-4.1", "openai")] },
        claudeMain,
        false,
        [MISTRAL, OLLAMA],
      );
      for (const index of [0, 1]) {
        const select = q(`backup-saved-model-${index}`) as HTMLSelectElement;
        expect(select.value).toBe("");
        expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
          "Custom (set it up below)",
          "Mistral via OpenRouter",
          "Qwen on my PC",
        ]);
      }
      expect(q("backup-add")?.textContent).toBe("Add a custom backup");
    });

    it("picking a saved model fills the backup and clears what does not apply", () => {
      render(
        { backups: [{ id: "a", provider: "local", model: "llama3.1", baseUrl: "http://old-pc:11434/v1", temperature: 1.2 }] },
        claudeMain,
        false,
        [MISTRAL, OLLAMA],
      );
      change(q("backup-saved-model-0"), MISTRAL.id);

      expect(value("backup-saved-model-0")).toBe(MISTRAL.id);
      expect(value("backup-provider-0")).toBe("openrouter");
      expect(value("backup-model-0")).toBe("mistralai/mistral-small-3.2-24b-instruct");
      // The old local address does not carry over to OpenRouter.
      expect(value("backup-baseurl-0")).toBe("");
      expect(value("backup-temperature-0")).toBe("0.7");
      expect(q("backup-saved-model-hint-0")?.textContent).toContain("Follows this saved model");

      click(q("backup-save"));
      expect(onSave.mock.calls[0]![0].laneABackupModels).toEqual([
        {
          id: "a",
          provider: "openrouter",
          model: "mistralai/mistral-small-3.2-24b-instruct",
          temperature: 0.7,
          directoryEntryId: MISTRAL.id,
        },
      ]);
    });

    it("copies the address of a local saved model and leaves Creativity on the model default", () => {
      render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, false, [MISTRAL, OLLAMA]);
      change(q("backup-temperature-0"), "1.2");
      change(q("backup-saved-model-0"), OLLAMA.id);

      expect(value("backup-provider-0")).toBe("local");
      expect(value("backup-model-0")).toBe("qwen3:14b");
      expect(value("backup-baseurl-0")).toBe("http://100.1.2.3:11434/v1");
      expect(value("backup-temperature-0")).toBe("");

      click(q("backup-save"));
      expect(onSave.mock.calls[0]![0].laneABackupModels).toEqual([
        { id: "a", provider: "local", model: "qwen3:14b", baseUrl: "http://100.1.2.3:11434/v1", directoryEntryId: OLLAMA.id },
      ]);
    });

    it("a change made by hand turns it back into a custom backup", () => {
      render({ backups: [{ ...entry("a", MISTRAL.model, "openrouter"), directoryEntryId: MISTRAL.id }] }, claudeMain, false, [
        MISTRAL,
      ]);
      expect(value("backup-saved-model-0")).toBe(MISTRAL.id);

      change(q("backup-temperature-0"), "0.2");
      expect(value("backup-saved-model-0")).toBe("");
      expect(value("backup-model-0")).toBe(MISTRAL.model);

      click(q("backup-save"));
      const saved = onSave.mock.calls[0]![0].laneABackupModels[0];
      expect(saved.temperature).toBe(0.2);
      expect(saved).not.toHaveProperty("directoryEntryId");
    });

    it("Custom keeps what is filled in and stops following the saved model", () => {
      render({ backups: [{ ...entry("a", MISTRAL.model, "openrouter"), directoryEntryId: MISTRAL.id }] }, claudeMain, false, [
        MISTRAL,
      ]);
      change(q("backup-saved-model-0"), "");
      expect(value("backup-provider-0")).toBe("openrouter");
      expect(value("backup-model-0")).toBe(MISTRAL.model);

      click(q("backup-save"));
      expect(onSave.mock.calls[0]![0].laneABackupModels).toEqual([
        { id: "a", provider: "openrouter", model: MISTRAL.model, temperature: 0.7 },
      ]);
    });

    it("shows a linked backup with the saved model's current settings, not an old copy", () => {
      // Stored when the saved model still pointed at OpenAI; it has been edited since.
      render({ backups: [{ ...entry("a", "gpt-4.1", "openai"), directoryEntryId: MISTRAL.id }] }, claudeMain, false, [
        MISTRAL,
      ]);
      expect(value("backup-saved-model-0")).toBe(MISTRAL.id);
      expect(value("backup-provider-0")).toBe("openrouter");
      expect(value("backup-model-0")).toBe(MISTRAL.model);
      // Nothing was changed by the person, so there is nothing to save yet.
      expect((q("backup-save") as HTMLButtonElement).disabled).toBe(true);

      change(q("backup-chain-no-answer-add"), "a");
      click(q("backup-save"));
      // Saving refreshes the stored copy as well.
      expect(onSave.mock.calls[0]![0].laneABackupModels).toEqual([
        { id: "a", provider: "openrouter", model: MISTRAL.model, temperature: 0.7, directoryEntryId: MISTRAL.id },
      ]);
    });

    it("keeps a backup's saved-model link when other things are saved", () => {
      render(
        { backups: [{ ...entry("a", MISTRAL.model, "openrouter"), directoryEntryId: MISTRAL.id }] },
        claudeMain,
        false,
        [MISTRAL],
      );
      change(q("backup-chain-no-answer-add"), "a");
      click(q("backup-save"));
      const patch = onSave.mock.calls[0]![0];
      expect(patch.laneABackupModels[0].directoryEntryId).toBe(MISTRAL.id);
      expect(patch.laneANoAnswerChainIds).toEqual(["a"]);
    });

    it("keeps the link as it is while the saved models are not loaded", () => {
      render({ backups: [{ ...entry("a", MISTRAL.model, "openrouter"), directoryEntryId: MISTRAL.id }] });
      expect(q("backup-saved-model-0")).toBeNull();
      change(q("backup-chain-no-answer-add"), "a");
      click(q("backup-save"));
      expect(onSave.mock.calls[0]![0].laneABackupModels[0].directoryEntryId).toBe(MISTRAL.id);
    });

    it("drops a link to a saved model that was deleted, keeping the backup's own fields", () => {
      const gone = "55555555-5555-4555-8555-555555555555";
      render({ backups: [{ ...entry("a", "gpt-4.1", "openai"), directoryEntryId: gone }] }, claudeMain, false, [MISTRAL]);
      expect(value("backup-saved-model-0")).toBe("");
      change(q("backup-chain-no-answer-add"), "a");
      click(q("backup-save"));
      expect(onSave.mock.calls[0]![0].laneABackupModels).toEqual([{ id: "a", provider: "openai", model: "gpt-4.1" }]);
    });

    it("adds a backup straight from a saved model, and offers each saved model once", () => {
      render({}, claudeMain, false, [MISTRAL, OLLAMA]);
      const addSelect = q("backup-add-saved") as HTMLSelectElement;
      expect(Array.from(addSelect.options).map((o) => o.textContent)).toEqual([
        "Add a saved model as a backup…",
        "Mistral via OpenRouter",
        "Qwen on my PC",
      ]);
      change(addSelect, MISTRAL.id);

      expect(container.querySelectorAll('[data-testid^="backup-entry-"]').length).toBe(1);
      expect(value("backup-saved-model-0")).toBe(MISTRAL.id);
      expect(value("backup-provider-0")).toBe("openrouter");
      expect(value("backup-model-0")).toBe(MISTRAL.model);
      expect(Array.from((q("backup-add-saved") as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
        "Add a saved model as a backup…",
        "Qwen on my PC",
      ]);
      // The lists name the backup after its saved model.
      expect((q("backup-chain-no-answer-add") as HTMLSelectElement).textContent).toContain("Backup 1 (Mistral via OpenRouter)");

      click(q("backup-save"));
      expect(onSave.mock.calls[0]![0].laneABackupModels[0]).toMatchObject({
        provider: "openrouter",
        model: MISTRAL.model,
        directoryEntryId: MISTRAL.id,
      });
    });

    it("stops offering saved models to add at the limit of five", () => {
      render(
        { backups: ["a", "b", "c", "d", "e"].map((id) => entry(id, "gpt-4.1", "openai")) },
        claudeMain,
        false,
        [MISTRAL],
      );
      expect((q("backup-add-saved") as HTMLSelectElement).disabled).toBe(true);
      expect((q("backup-add") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("backupFieldsFromDirectoryEntry", () => {
    it("keeps an address only for a provider that takes one", () => {
      expect(backupFieldsFromDirectoryEntry(savedModel({ provider: "anthropic", model: "claude-sonnet-5", baseUrl: "http://x/v1" })).baseUrl).toBe("");
      expect(backupFieldsFromDirectoryEntry(OLLAMA).baseUrl).toBe("http://100.1.2.3:11434/v1");
    });
    it("links the backup to the saved model and turns no creativity into the model default", () => {
      expect(backupFieldsFromDirectoryEntry(OLLAMA)).toEqual({
        provider: "local",
        model: "qwen3:14b",
        baseUrl: "http://100.1.2.3:11434/v1",
        temperature: "",
        directoryEntryId: OLLAMA.id,
      });
    });
  });

  it("hides editing controls when the person cannot edit", () => {
    render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, true);
    expect(q("backup-save")).toBeNull();
    expect((q("backup-add") as HTMLButtonElement).disabled).toBe(true);
  });
});

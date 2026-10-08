// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneABackupModelConfig, LaneAKeywordRoute, LaneAProvider, ModelDirectoryEntry } from "@paperclipai/shared";
import { QuickAgentBackupModels, type BackupProviderKeys } from "./QuickAgentBackupModels";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

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

  function render(
    saved: Saved = {},
    main = claudeMain,
    disabled = false,
    savedModels?: ModelDirectoryEntry[],
    keys: {
      providerKeys?: BackupProviderKeys;
      stashedBaseUrls?: Partial<Record<LaneAProvider, string | null>>;
      renderProviderKeyPicker?: (provider: LaneAProvider) => React.ReactNode;
    } = {},
  ) {
    act(() => {
      root.render(
        <QuickAgentBackupModels
          saved={saved}
          main={main}
          disabled={disabled}
          savedModels={savedModels}
          onSave={onSave}
          {...keys}
        />,
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
    expect(q("backup-test-result-0")?.textContent).toBe("Pick an OpenAI key for this backup.");
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

  describe("a backup on another provider uses the agent's key for that provider", () => {
    const localMain: { provider: LaneAProvider; baseUrl: string | null; hasKey: boolean } = {
      provider: "local",
      baseUrl: "http://pc:11434/v1",
      hasKey: false,
    };
    const openRouterBackup = entry("or", "meta-llama/llama-3.3-70b-instruct", "openrouter");
    const picker = (provider: LaneAProvider) => <span data-testid={`picker-${provider}`}>picker</span>;

    it("shows a key picker on the OpenRouter row and says which key it will use", () => {
      render({ backups: [openRouterBackup, entry("cl", "claude-sonnet-5")] }, localMain, false, undefined, {
        providerKeys: { openrouter: { name: "Openrouter" } },
        renderProviderKeyPicker: picker,
      });
      expect(q("backup-key-0")?.querySelector('[data-testid="picker-openrouter"]')).not.toBeNull();
      // Claude needs no key of its own here: no picker on that row.
      expect(q("backup-key-1")).toBeNull();
      click(q("backup-test-0"));
      expect(q("backup-test-result-0")?.textContent).toBe('Ready. It uses the agent\'s OpenRouter key "Openrouter".');
    });

    it("asks for a key when the agent has none for that provider", () => {
      render({ backups: [openRouterBackup] }, localMain, false, undefined, { renderProviderKeyPicker: picker });
      click(q("backup-test-0"));
      expect(q("backup-test-result-0")?.textContent).toBe("Pick an OpenRouter key for this backup.");
    });

    it("will not send the key to an address it was not picked for", () => {
      render({ backups: [{ ...openRouterBackup, baseUrl: "https://elsewhere.example/v1" }] }, localMain, false, undefined, {
        providerKeys: { openrouter: { name: "Openrouter" } },
      });
      click(q("backup-test-0"));
      expect(q("backup-test-result-0")?.textContent).toContain("so that key is not sent there");
    });

    it("no picker on a backup that shares the main model's provider", () => {
      render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, false, undefined, {
        renderProviderKeyPicker: picker,
      });
      expect(q("backup-key-0")).toBeNull();
    });
  });

  it("hides editing controls when the person cannot edit", () => {
    render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, true);
    expect(q("backup-save")).toBeNull();
    expect((q("backup-add") as HTMLButtonElement).disabled).toBe(true);
  });

  describe("saved models", () => {
    const savedModel = (over: Partial<ModelDirectoryEntry>): ModelDirectoryEntry => ({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "c1",
      name: "Saved",
      provider: "openrouter",
      model: "mistralai/mistral-small",
      baseUrl: null,
      providerRouting: null,
      defaultThinking: null,
      defaultTemperature: null,
      defaultMaxOutputTokens: null,
      backupEntryIds: [],
      note: null,
      maker: null,
      baseModel: null,
      lane: null,
      availability: null,
      tags: [],
      specs: null,
      favorite: false,
      archivedAt: null,
      family: null,
      variant: null,
      ratings: [],
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      ...over,
    });
    const GEMMA = savedModel({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Gemma on my PC",
      provider: "local",
      model: "gemma3:12b",
      baseUrl: "http://pc:11434/v1",
      defaultTemperature: 0.4,
      maker: "Google",
      baseModel: "Gemma 3",
      variant: "12B",
    });
    const MISTRAL = savedModel({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Mistral via OpenRouter",
      maker: "Mistral",
    });
    const OLD = savedModel({
      id: "44444444-4444-4444-8444-444444444444",
      name: "Old archived one",
      archivedAt: "2026-10-02T00:00:00Z",
    });

    it("offers saved models grouped by maker, leaving archived ones out", () => {
      render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, false, [MISTRAL, GEMMA, OLD]);
      const select = q("backup-saved-model-0") as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.value).toBe("");
      expect([...select.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Google · Gemma 3", "Mistral"]);
      // Size (when known) · where it runs, plus the saved name when it adds something.
      expect([...select.querySelectorAll("optgroup option")].map((o) => o.textContent)).toEqual([
        "12B · On your PC (gemma3:12b) — Gemma on my PC",
        "OpenRouter — Mistral via OpenRouter",
      ]);
      expect(select.textContent).toContain("Type it myself");
      expect(select.textContent).toContain("Gemma on my PC");
      expect(select.textContent).not.toContain("Old archived one");
      // Manual fields still there while nothing is picked.
      expect(q("backup-provider-0")).not.toBeNull();
    });

    it("has no saved-model picker when there are no saved models", () => {
      render({ backups: [entry("a", "gpt-4.1-mini", "openai")] });
      expect(q("backup-saved-model-0")).toBeNull();
      expect(q("backup-provider-0")).not.toBeNull();
    });

    it("picking a saved model fills the backup and saves the link", () => {
      render({ backups: [entry("a", "gpt-4.1-mini", "openai")] }, claudeMain, false, [GEMMA, MISTRAL]);
      change(q("backup-saved-model-0"), GEMMA.id);
      expect(q("backup-provider-0")).toBeNull();
      expect(q("backup-saved-model-summary-0")?.textContent).toContain('Uses "Gemma on my PC"');
      click(q("backup-save"));
      const patch = onSave.mock.calls[0]![0];
      expect(patch.laneABackupModels).toEqual([
        {
          id: "a",
          provider: "local",
          model: "gemma3:12b",
          baseUrl: "http://pc:11434/v1",
          temperature: 0.4,
          directoryEntryId: GEMMA.id,
        },
      ]);
    });

    it("shows the saved model's name for a backup that already uses one", () => {
      render(
        {
          backups: [{ id: "a", provider: "openrouter", model: "mistralai/mistral-small", directoryEntryId: MISTRAL.id }],
          noAnswerChainIds: ["a"],
        },
        claudeMain,
        false,
        [MISTRAL],
      );
      expect((q("backup-saved-model-0") as HTMLSelectElement).value).toBe(MISTRAL.id);
      expect(q("backup-saved-model-summary-0")?.textContent).toContain("Mistral via OpenRouter");
      expect(q("backup-chain-no-answer-item-0")?.textContent).toContain("Backup 1 (Mistral via OpenRouter)");
    });

    it("'Type it myself' drops the link and keeps the filled-in details", () => {
      render(
        { backups: [{ id: "a", provider: "openrouter", model: "mistralai/mistral-small", directoryEntryId: MISTRAL.id }] },
        claudeMain,
        false,
        [MISTRAL],
      );
      change(q("backup-saved-model-0"), "");
      expect((q("backup-provider-0") as HTMLSelectElement).value).toBe("openrouter");
      expect((q("backup-model-0") as HTMLInputElement).value).toBe("mistralai/mistral-small");
      click(q("backup-save"));
      const saved = onSave.mock.calls[0]![0].laneABackupModels[0];
      expect(saved.directoryEntryId).toBeUndefined();
      expect(saved.model).toBe("mistralai/mistral-small");
    });

    it("keeps a link to a saved model that is no longer listed and says so", () => {
      render(
        { backups: [{ id: "a", provider: "openrouter", model: "x/y", directoryEntryId: OLD.id }] },
        claudeMain,
        false,
        [MISTRAL],
      );
      expect((q("backup-saved-model-0") as HTMLSelectElement).value).toBe(OLD.id);
      expect(q("backup-saved-model-summary-0")?.textContent).toContain("archived or deleted");
      expect((q("backup-save") as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

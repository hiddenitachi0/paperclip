// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelReadiness, type ModelDirectoryEntry } from "@paperclipai/shared";
import { ModelCatalogueRow } from "./ModelCatalogueRow";
import { setupFromEntry } from "./ModelReadiness";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY: ModelDirectoryEntry = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "11111111-1111-4111-8111-111111111111",
  name: "Qwen at the office",
  provider: "local",
  model: "qwen3:14b",
  baseUrl: null,
  providerRouting: null,
  defaultThinking: null,
  defaultTemperature: null,
  defaultMaxOutputTokens: null,
  backupEntryIds: [],
  note: null,
  maker: null,
  baseModel: null,
  lane: "quick",
  availability: "installed",
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
};

describe("Settings > Models: the Ready? badge", () => {
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    container?.remove();
    container = null;
  });

  it("summarises the checklist and opens it, with a fix link for the missing address", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const lines = modelReadiness(setupFromEntry(ENTRY), { gpuVramGb: 16 });
    const noop = () => undefined;
    const root = createRoot(container);
    act(() => {
      root.render(
        <ul>
          <ModelCatalogueRow
            entry={ENTRY}
            companyId={ENTRY.companyId}
            canManage
            expanded={false}
            checkingUp={false}
            busy={false}
            onToggleExpanded={noop}
            onToggleCheckUp={noop}
            onToggleFavorite={noop}
            onEdit={noop}
            onDuplicate={noop}
            onToggleArchived={noop}
            onDelete={noop}
            onCopyText={noop}
            readiness={lines}
          />
        </ul>,
      );
    });
    const badge = container.querySelector<HTMLButtonElement>(`[data-testid="model-ready-${ENTRY.id}"]`)!;
    expect(badge.dataset.status).toBe("fail");
    expect(badge.textContent).toMatch(/Ready\? Not ready \(1 to fix\)/);
    expect(container.querySelector(`[data-testid="model-ready-${ENTRY.id}-lines"]`)).toBeNull();
    act(() => badge.click());
    const address = container.querySelector<HTMLElement>(`[data-testid="model-ready-${ENTRY.id}-lines-address"]`)!;
    expect(address.dataset.status).toBe("fail");
    expect(address.querySelector("a")!.getAttribute("href")).toBe("/company/settings/models");
    expect(address.textContent).toContain("Set the model server address");
    act(() => root.unmount());
  });
});

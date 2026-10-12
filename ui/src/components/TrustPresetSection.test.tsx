// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPermissions } from "@paperclipai/shared";
import { TrustPresetSection } from "./TrustPresetSection";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderSection(permissions: Partial<AgentPermissions>, options: { embedded?: boolean } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const onChange = vi.fn();
  const createdRoot = createRoot(container);
  root = createdRoot;
  flushSync(() => {
    createdRoot.render(
      <TooltipProvider>
        <TrustPresetSection
          permissions={permissions}
          onChange={onChange}
          companyId="company-1"
          projectCandidates={[{ id: "project-1", label: "Paperclip App" }]}
          issueCandidates={[{ id: "issue-1", label: "PAP-1 · Review PR" }]}
          embedded={options.embedded}
        />
      </TooltipProvider>,
    );
  });
  return { onChange, text: () => container?.textContent ?? "" };
}

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("TrustPresetSection", () => {
  it("hides the CE boundary editor under Standard", () => {
    const view = renderSection({ canCreateAgents: false, trustPreset: "standard" });

    expect(view.text()).toContain("Trust preset");
    expect(view.text()).not.toContain("Boundary type");
    expect(view.text()).not.toContain("Get Paperclip EE.");
  });

  it("shows a selectable CE boundary editor for low-trust review", () => {
    const view = renderSection({
      canCreateAgents: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          projectIds: ["project-1"],
        },
      },
    });

    expect(view.text()).toContain("Containment active");
    expect(view.text()).toContain("Boundary type");
    expect(view.text()).toContain("Paperclip App");
    expect(view.text()).toContain("Get Paperclip EE.");
    expect(view.text()).not.toContain("Managed by EE/API");
  });

  it("renders multi-boundary policies as read-only", () => {
    const view = renderSection({
      canCreateAgents: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        trustBoundary: {
          mode: "low_trust_review",
          companyId: "company-1",
          projectIds: ["project-1", "project-2"],
        },
      },
    });

    expect(view.text()).toContain("Managed by EE/API");
    expect(view.text()).toContain("2 boundaries");
    expect(view.text()).not.toContain("Clear boundary");
  });

  it("drops its own heading and frame when embedded in a page section, keeping the fields", () => {
    const view = renderSection({ canCreateAgents: false, trustPreset: "standard" }, { embedded: true });

    expect(container?.querySelector("h3")).toBeNull();
    expect(container?.querySelector(".rounded-lg.border")).toBeNull();
    expect(view.text()).toContain("Trust preset");
    expect(container?.querySelector('[data-testid="trust-preset-section"] select')).not.toBeNull();
  });

  it("keeps the Trust heading and frame by default", () => {
    renderSection({ canCreateAgents: false, trustPreset: "standard" });

    expect(container?.querySelector("h3")?.textContent).toBe("Trust");
    expect(container?.querySelector(".rounded-lg.border")).not.toBeNull();
  });
});

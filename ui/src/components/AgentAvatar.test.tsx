// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

// Fixture agents — not live production data, per the "do not pin to live rows" requirement.
const FIXTURE_AGENTS = [
  { id: "fixture-1", name: "Fixture One", icon: "rocket", avatarAssetId: null },
  { id: "fixture-2", name: "Fixture Two", icon: "shield", avatarAssetId: null },
  { id: "fixture-3", name: "Fixture Three", icon: "crown", avatarAssetId: null },
];

describe("AgentAvatar", () => {
  it.each(FIXTURE_AGENTS)(
    "renders the $icon symbol when avatarAssetId is null ($name)",
    (agent) => {
      const el = render(<AgentAvatar agent={agent} />);
      const fallback = el.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeTruthy();
      expect(fallback?.querySelector("svg")).toBeTruthy();
      expect(el.querySelector('[data-slot="avatar-image"]')).toBeFalsy();
    },
  );

  it("renders the default symbol when no agent is supplied", () => {
    const el = render(<AgentAvatar agent={null} />);
    expect(el.querySelector('[data-slot="avatar-fallback"] svg')).toBeTruthy();
  });

  it("renders the symbol until the picture loads when avatarAssetId is set", () => {
    // Radix only mounts <img> once the image's load event fires; jsdom's
    // window.Image never fires load or error, so the symbol stays visible.
    // This deliberately can't prove the broken-URL-falls-back-to-symbol case —
    // only that the initial, always-true-in-jsdom state renders the symbol.
    const el = render(
      <AgentAvatar agent={{ icon: "bot", avatarAssetId: "fixture-asset-id" }} />,
    );
    expect(el.querySelector('[data-slot="avatar-fallback"] svg')).toBeTruthy();
    expect(el.querySelector('[data-slot="avatar-image"]')).toBeFalsy();
  });

  it.each(["default", "xs", "sm", "lg"] as const)("renders at the %s size without crashing", (size) => {
    const el = render(<AgentAvatar agent={{ icon: "bot" }} size={size} />);
    expect(el.querySelector('[data-slot="avatar"]')).toBeTruthy();
  });
});

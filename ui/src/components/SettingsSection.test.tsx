// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsSection, SettingsSubsection } from "./SettingsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function trigger(testId: string) {
  return container.querySelector(`[data-testid="${testId}"] button`) as HTMLButtonElement;
}

describe("SettingsSection", () => {
  it("folds away and back, keeping its fields mounted, and shows the summary while closed", () => {
    act(() =>
      root.render(
        <SettingsSection title="Model and limits" summary="OpenRouter · qwen3.8-27b" data-testid="sec">
          <input data-testid="field" defaultValue="typed" />
        </SettingsSection>,
      ),
    );
    const section = container.querySelector('[data-testid="sec"]')!;
    expect(section.getAttribute("data-state")).toBe("open");
    expect(container.textContent).not.toContain("OpenRouter · qwen3.8-27b");

    act(() => trigger("sec").click());
    expect(section.getAttribute("data-state")).toBe("closed");
    expect(container.textContent).toContain("OpenRouter · qwen3.8-27b");
    expect(container.querySelector('[data-testid="field"]')).not.toBeNull();
  });

  it("remembers open/closed per storage key", () => {
    act(() =>
      root.render(
        <SettingsSubsection title="Backups" storageKey="test.backups" defaultOpen data-testid="sub">
          <p>content</p>
        </SettingsSubsection>,
      ),
    );
    act(() => trigger("sub").click());
    expect(window.localStorage.getItem("paperclip.settingsSection.test.backups")).toBe("0");

    act(() => root.unmount());
    root = createRoot(container);
    act(() =>
      root.render(
        <SettingsSubsection title="Backups" storageKey="test.backups" defaultOpen data-testid="sub">
          <p>content</p>
        </SettingsSubsection>,
      ),
    );
    expect(container.querySelector('[data-testid="sub"]')!.getAttribute("data-state")).toBe("closed");
  });

  it("starts at the default when nothing is stored", () => {
    act(() =>
      root.render(
        <SettingsSection title="API keys" defaultOpen={false} storageKey="test.keys" data-testid="keys">
          <p>keys</p>
        </SettingsSection>,
      ),
    );
    expect(container.querySelector('[data-testid="keys"]')!.getAttribute("data-state")).toBe("closed");
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HiddenInPresentationMode } from "./HiddenInPresentationMode";
import { PresentationModeProvider, usePresentationMode } from "../context/PresentationModeContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ToggleButton() {
  const { toggle } = usePresentationMode();
  return (
    <button type="button" data-testid="toggle" onClick={toggle}>
      toggle
    </button>
  );
}

describe("HiddenInPresentationMode", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders children directly when presentation mode is off", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <HiddenInPresentationMode label="Finance report">
            <div data-testid="content">Revenue: 1,234,567 kr</div>
          </HiddenInPresentationMode>
        </PresentationModeProvider>,
      );
    });

    expect(container.textContent).toContain("Revenue: 1,234,567 kr");
    expect(container.textContent).not.toContain("Hidden in presentation mode");

    act(() => root.unmount());
  });

  it("shows a placeholder and withholds children when presentation mode is on", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <ToggleButton />
          <HiddenInPresentationMode label="Finance report">
            <div data-testid="content">Revenue: 1,234,567 kr</div>
          </HiddenInPresentationMode>
        </PresentationModeProvider>,
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid='toggle']")?.click();
    });

    expect(container.textContent).toContain("Hidden in presentation mode");
    expect(container.textContent).toContain("Finance report");
    expect(container.textContent).not.toContain("1,234,567");

    act(() => root.unmount());
  });

  it("reveals the panel on click without turning off presentation mode globally", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <ToggleButton />
          <HiddenInPresentationMode label="Finance report">
            <div data-testid="content">Revenue: 1,234,567 kr</div>
          </HiddenInPresentationMode>
        </PresentationModeProvider>,
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid='toggle']")?.click();
    });
    expect(container.textContent).toContain("Hidden in presentation mode");

    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid='reveal-panel']")?.click();
    });

    expect(container.textContent).toContain("1,234,567 kr");

    act(() => root.unmount());
  });
});

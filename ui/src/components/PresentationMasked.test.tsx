// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresentationMasked } from "./PresentationMasked";
import { PresentationModeProvider, usePresentationMode } from "../context/PresentationModeContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ text, keepList }: { text: string; keepList?: string[] }) {
  const { toggle, setKeepList } = usePresentationMode();
  return (
    <div>
      <button type="button" data-testid="toggle" onClick={toggle}>
        toggle
      </button>
      <button type="button" data-testid="set-keep" onClick={() => setKeepList(keepList ?? [])}>
        set keep
      </button>
      <span data-testid="out">
        <PresentationMasked>{text}</PresentationMasked>
      </span>
    </div>
  );
}

describe("PresentationMasked", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders original text untouched while presentation mode is off", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Harness text="Contact filip@nordstrand.no, revenue 1 234 567 kr" />
        </PresentationModeProvider>,
      );
    });

    expect(container.querySelector("[data-testid='out']")?.textContent).toBe(
      "Contact filip@nordstrand.no, revenue 1 234 567 kr",
    );

    act(() => root.unmount());
  });

  it("masks money and emails once presentation mode is on", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Harness text="Contact filip@nordstrand.no, revenue 1 234 567 kr" />
        </PresentationModeProvider>,
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid='toggle']")?.click();
    });

    const out = container.querySelector("[data-testid='out']")?.textContent ?? "";
    expect(out).not.toContain("filip@nordstrand.no");
    expect(out).not.toContain("1 234 567");

    act(() => root.unmount());
  });
});

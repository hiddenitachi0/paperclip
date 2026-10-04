// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresentationModeProvider, usePresentationMode, type PresentationModeSettings } from "./PresentationModeContext";

const STORAGE_KEY = "paperclip.presentationMode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("PresentationModeContext", () => {
  let container: HTMLDivElement;
  let observed: PresentationModeSettings | null = null;
  let ctx: ReturnType<typeof usePresentationMode> | null = null;

  function Probe() {
    const value = usePresentationMode();
    observed = value;
    ctx = value;
    return null;
  }

  beforeEach(() => {
    window.localStorage.clear();
    observed = null;
    ctx = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("defaults to disabled and never writes anything until a provider mounts", () => {
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Probe />
        </PresentationModeProvider>,
      );
    });

    expect(observed?.enabled).toBe(false);
    expect(observed?.strict).toBe(false);
    expect(observed?.keepList).toEqual([]);

    act(() => root.unmount());
  });

  it("toggling persists only to localStorage, never anywhere else", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Probe />
        </PresentationModeProvider>,
      );
    });

    act(() => ctx?.toggle());
    expect(observed?.enabled).toBe(true);

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.enabled).toBe(true);

    act(() => root.unmount());
  });

  it("restores a previously persisted state on mount", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: true,
        strict: true,
        keepList: ["Filip"],
        extraMaskedNames: ["Kari Nordmann"],
        extraHiddenPages: ["/costs"],
      }),
    );

    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Probe />
        </PresentationModeProvider>,
      );
    });

    expect(observed?.enabled).toBe(true);
    expect(observed?.strict).toBe(true);
    expect(observed?.keepList).toEqual(["Filip"]);
    expect(observed?.extraMaskedNames).toEqual(["Kari Nordmann"]);
    expect(observed?.extraHiddenPages).toEqual(["/costs"]);

    act(() => root.unmount());
  });

  it("ignores malformed persisted state instead of throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "not json");

    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Probe />
        </PresentationModeProvider>,
      );
    });

    expect(observed?.enabled).toBe(false);

    act(() => root.unmount());
  });

  it("toggles on Cmd/Ctrl+Shift+P", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Probe />
        </PresentationModeProvider>,
      );
    });

    expect(observed?.enabled).toBe(false);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(observed?.enabled).toBe(true);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, shiftKey: true, bubbles: true }),
      );
    });
    expect(observed?.enabled).toBe(false);

    act(() => root.unmount());
  });

  it("setKeepList/setExtraMaskedNames/setExtraHiddenPages/setStrict update and persist", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <PresentationModeProvider>
          <Probe />
        </PresentationModeProvider>,
      );
    });

    act(() => {
      ctx?.setStrict(true);
      ctx?.setKeepList(["Filip", "Nordstrand AS"]);
      ctx?.setExtraMaskedNames(["Kari Nordmann"]);
      ctx?.setExtraHiddenPages(["/costs"]);
    });

    expect(observed?.strict).toBe(true);
    expect(observed?.keepList).toEqual(["Filip", "Nordstrand AS"]);
    expect(observed?.extraMaskedNames).toEqual(["Kari Nordmann"]);
    expect(observed?.extraHiddenPages).toEqual(["/costs"]);

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.keepList).toEqual(["Filip", "Nordstrand AS"]);

    act(() => root.unmount());
  });

  it("throws when used outside a provider", () => {
    function Bare() {
      usePresentationMode();
      return null;
    }
    const root = createRoot(container);
    expect(() => {
      act(() => {
        root.render(<Bare />);
      });
    }).toThrow("usePresentationMode must be used within PresentationModeProvider");
  });
});

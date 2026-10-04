// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme, type ThemePreference } from "./ThemeContext";

const THEME_STORAGE_KEY = "paperclip.theme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MediaListener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener: (type: "change", listener: MediaListener) => void;
  removeEventListener: (type: "change", listener: MediaListener) => void;
  dispatch: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMedia(initialMatches: boolean): FakeMediaQueryList {
  const listeners = new Set<MediaListener>();
  const mql: FakeMediaQueryList = {
    matches: initialMatches,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    dispatch: (matches) => {
      mql.matches = matches;
      const event = { matches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
    listenerCount: () => listeners.size,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query !== "(prefers-color-scheme: dark)") {
        throw new Error(`unexpected media query: ${query}`);
      }
      return mql as unknown as MediaQueryList;
    },
  });
  return mql;
}

describe("ThemeContext", () => {
  let container: HTMLDivElement;
  let observedTheme: "light" | "dark" | null = null;
  let observedPreference: ThemePreference | null = null;
  let setTheme: ((preference: ThemePreference) => void) | null = null;
  let toggleTheme: (() => void) | null = null;

  function Probe() {
    const ctx = useTheme();
    observedTheme = ctx.theme;
    observedPreference = ctx.preference;
    setTheme = ctx.setTheme;
    toggleTheme = ctx.toggleTheme;
    return null;
  }

  function mount() {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });
    return root;
  }

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    observedTheme = null;
    observedPreference = null;
    setTheme = null;
    toggleTheme = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("defaults a new browser to 'system' and follows OS prefers-color-scheme changes without persisting", () => {
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(true);

    const root = mount();

    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      mql.dispatch(false);
    });
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("stops listening to OS changes after an explicit light/dark choice and persists it", () => {
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(true);

    const root = mount();
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      setTheme?.("light");
    });
    expect(observedTheme).toBe("light");
    expect(observedPreference).toBe("light");
    expect(mql.listenerCount()).toBe(0);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("light");

    act(() => {
      toggleTheme?.();
    });
    expect(observedTheme).toBe("dark");
    expect(observedPreference).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("does not attach the OS listener when a stored light/dark choice already exists", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const mql = installMatchMedia(true);

    const root = mount();

    expect(observedPreference).toBe("light");
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).not.toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("a stored 'system' choice follows the OS and stays stored as 'system'", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(true);

    const root = mount();

    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("dark");
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      mql.dispatch(false);
    });
    expect(observedTheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");

    act(() => {
      root.unmount();
    });
  });

  it("choosing 'system' after an explicit theme re-attaches the OS listener and resolves from the OS immediately", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    document.documentElement.classList.add("dark");
    const mql = installMatchMedia(false);

    const root = mount();
    expect(observedTheme).toBe("dark");
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      setTheme?.("system");
    });
    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(mql.listenerCount()).toBe(1);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("dark");

    act(() => {
      root.unmount();
    });
  });

  it("ignores unknown stored values and treats them as 'system'", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    const mql = installMatchMedia(false);

    const root = mount();

    expect(observedPreference).toBe("system");
    expect(mql.listenerCount()).toBe(1);
    // Nothing valid was stored, so nothing is written until the user chooses.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("sepia");

    act(() => {
      root.unmount();
    });
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

type Preference = "light" | "dark" | "system";

const mockSetTheme = vi.hoisted(() => vi.fn());
const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockState = vi.hoisted(() => ({
  theme: "dark" as "dark" | "light",
  preference: "dark" as Preference,
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: mockState.theme,
    preference: mockState.preference,
    setTheme: mockSetTheme,
    toggleTheme: mockToggleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ThemeToggle", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockState.theme = "dark";
    mockState.preference = "dark";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("icon variant cycles dark → system: the accessible name says 'Follow system theme' and a click stores 'system'", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Follow system theme");
    expect(button?.getAttribute("title")).toBe("Theme: Dark. Follow system theme");

    await act(async () => {
      button?.click();
    });
    expect(mockSetTheme).toHaveBeenCalledTimes(1);
    expect(mockSetTheme).toHaveBeenCalledWith("system");

    await act(async () => root.unmount());
  });

  it("icon variant cycles system → light and light → dark", async () => {
    mockState.preference = "system";
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Switch to light mode");
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(mockSetTheme).toHaveBeenLastCalledWith("light");

    mockState.preference = "light";
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Switch to dark mode");
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(mockSetTheme).toHaveBeenLastCalledWith("dark");

    await act(async () => root.unmount());
  });

  it("menu-action variant renders an Appearance picker with Light / Dark / System and marks the stored choice", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="menu-action" />);
    });
    await flushReact();

    expect(container.textContent).toContain("Appearance");
    expect(container.textContent).toContain("Light, dark, or follow your system setting.");
    const radios = Array.from(container.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Light", "Dark", "System"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);

    await act(async () => root.unmount());
  });

  it("menu-action variant explains what 'system' currently resolves to", async () => {
    mockState.preference = "system";
    mockState.theme = "light";
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="menu-action" />);
    });
    await flushReact();

    expect(container.textContent).toContain("Following your system setting (currently light).");
    const checked = container.querySelector('[role="radio"][aria-checked="true"]');
    expect(checked?.textContent?.trim()).toBe("System");

    await act(async () => root.unmount());
  });

  it("choosing an option stores it and calls onAfterToggle (used by SidebarAccountMenu to close the popover)", async () => {
    const onAfterToggle = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="menu-action" onAfterToggle={onAfterToggle} />);
    });
    await flushReact();

    const light = container.querySelector('[role="radio"][aria-label="Switch to light mode"]') as HTMLButtonElement | null;
    expect(light).not.toBeNull();
    await act(async () => {
      light?.click();
    });

    expect(mockSetTheme).toHaveBeenCalledTimes(1);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
    expect(onAfterToggle).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradingTemplateGallery } from "./TradingTemplateGallery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tradingApi = vi.hoisted(() => ({ templates: vi.fn(), createFromTemplate: vi.fn() }));
vi.mock("../api/trading", () => ({ tradingApi }));

const template = (key: string, name: string, family = "trend", problems: string[] = []) => ({
  key,
  templateVersion: 1,
  wave: "first",
  name,
  family,
  thesis: `${name} thesis`,
  worksWhen: ["A clean trend."],
  failsWhen: ["A choppy market."],
  allowedWeather: { trend: ["up"], squeeze: "no", note: "n" },
  requiresData: [],
  controlKind: family === "control" ? "buy_and_hold" : null,
  simplifications: [],
  decisionTimeframe: "4h",
  assets: ["BTC", "ETH"],
  problems,
  label: "not yet tested on past data",
  passedPastDataChecks: false,
  report: null,
});

const library = {
  templates: [template("pullback_trend", "Pullback in a trend"), template("buy_and_hold", "Buy and hold", "control"), template("broken", "Broken style", "trend", ["bad"])],
  excluded: [{ key: "gap_and_go", name: "Gap-and-go", reason: "Crypto has no opening gap." }],
};

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(onCreated = vi.fn(), onError = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TradingTemplateGallery companyId="c1" onCreated={onCreated} onError={onError} />
      </QueryClientProvider>,
    );
  });
  return { container, onCreated, onError };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("TradingTemplateGallery", () => {
  it("stays closed until asked, then lists styles, yardsticks and the greyed-out style", async () => {
    tradingApi.templates.mockResolvedValue(library);
    const { container } = await render();
    expect(tradingApi.templates).not.toHaveBeenCalled();
    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Browse templates") as HTMLButtonElement).click();
    });
    await settle();
    expect(container.querySelectorAll('[data-testid="template-card"]')).toHaveLength(3);
    expect(container.querySelector('[data-testid="template-excluded"]')!.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("Paper only, not investment advice.");
    expect(container.textContent).toContain("This style has a problem and cannot be used yet.");
    expect(container.textContent!.toLowerCase()).not.toMatch(/\bready\b|promising/);
  });

  it("creates the strategy from the chosen style and coin, then hands over its id", async () => {
    tradingApi.templates.mockResolvedValue(library);
    tradingApi.createFromTemplate.mockResolvedValue({ id: "s1" });
    const { container, onCreated } = await render();
    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Browse templates") as HTMLButtonElement).click();
    });
    await settle();
    const select = container.querySelector("#template-coin-pullback_trend") as HTMLSelectElement;
    await act(async () => {
      select.value = "ETH";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('button[aria-label="Use Pullback in a trend for ETH"]') as HTMLButtonElement).click();
    });
    await settle();
    expect(tradingApi.createFromTemplate).toHaveBeenCalledWith("c1", { templateKey: "pullback_trend", asset: "ETH" });
    expect(onCreated).toHaveBeenCalledWith("s1");
  });
});

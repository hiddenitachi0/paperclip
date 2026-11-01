// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { TradingStrategySpec } from "@paperclipai/shared";
import { GUIDELINES_LABEL, TradingStrategyEditor } from "./TradingStrategyEditor";
import { starterSpec } from "../lib/tradingRuleBook";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: { spec: TradingStrategySpec; guidelines: string } | null = null;

function Harness() {
  const [spec, setSpec] = useState(starterSpec("Trend", "BTC", "4h"));
  const [guidelines, setGuidelines] = useState("");
  latest = { spec, guidelines };
  return <TradingStrategyEditor mode="create" spec={spec} guidelines={guidelines} onSpecChange={setSpec} onGuidelinesChange={setGuidelines} startingCashNok={3000} onStartingCashChange={() => {}} />;
}

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
  return { container, root };
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = "";
  latest = null;
});

describe("TradingStrategyEditor", () => {
  it("shows every section, the read-back sentence and the labelled notes box", async () => {
    const { container, root } = await render();
    const titles = [...container.querySelectorAll("section")].map((s) => s.getAttribute("aria-label"));
    expect(titles).toEqual([
      "About this strategy",
      "What it watches",
      "When it buys",
      "When it sells",
      "When it stays out",
      "Never do",
      "How much",
      "What it predicts",
      "Your guidelines",
    ]);
    expect(container.querySelector('[data-testid="strategy-read-back"]')?.textContent).toContain("It buys when the 10-candle average price moves up past the 30-candle average price.");
    expect(container.textContent).toContain(GUIDELINES_LABEL);
    expect(GUIDELINES_LABEL).toBe("Notes for the analyst. The AI reads these to suggest rule changes; the trading code never reads them.");
    const kind = container.querySelector<HTMLSelectElement>('[data-testid="strategy-measure"] select')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(kind, "atr");
      kind.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("ATR means the average size of a candle");
    await act(async () => root.unmount());
  });

  it("updates the read-back sentence as the numbers change", async () => {
    const { container, root } = await render();
    const fastPeriod = container.querySelectorAll<HTMLInputElement>('[data-testid="strategy-measure"] input[type="number"]')[0]!;
    await act(async () => setInput(fastPeriod, "12"));
    expect(container.querySelector('[data-testid="strategy-read-back"]')?.textContent).toContain("the 12-candle average price moves up past");
    expect(latest?.spec.indicators.fast).toEqual({ kind: "sma", period: 12 });
    await act(async () => root.unmount());
  });

  it("does not let a measure that a rule uses be removed", async () => {
    const { container, root } = await render();
    const remove = container.querySelector<HTMLButtonElement>('[data-testid="strategy-measure"] button')!;
    expect(remove.disabled).toBe(true);
    expect(container.textContent).toContain("Take it out there first");
    await act(async () => root.unmount());
  });

  it("only writes a limit into the rules when it is changed", async () => {
    const { container, root } = await render();
    expect(latest?.spec.neverDo).toEqual({});
    const mostInOneBuy = [...container.querySelectorAll<HTMLInputElement>("input[type=number]")].find((i) => i.max === "5000")!;
    await act(async () => setInput(mostInOneBuy, "800"));
    expect(latest?.spec.neverDo).toEqual({ maxPositionNok: 800 });
    await act(async () => root.unmount());
  });

  it("keeps the notes for the analyst out of the rules", async () => {
    const { container, root } = await render();
    const box = container.querySelector<HTMLTextAreaElement>("textarea[maxlength='8000']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "Prefer to miss a trade");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(latest?.guidelines).toBe("Prefer to miss a trade");
    expect(JSON.stringify(latest?.spec)).not.toContain("Prefer to miss a trade");
    await act(async () => root.unmount());
  });
});

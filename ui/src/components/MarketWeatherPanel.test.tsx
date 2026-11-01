// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketWeatherPanel } from "./MarketWeatherPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tradingApi = vi.hoisted(() => ({ marketWeather: vi.fn(), marketWeatherHistory: vi.fn() }));
vi.mock("../api/trading", () => ({ tradingApi }));

const btc = {
  asset: "BTC",
  name: "Bitcoin",
  text: "Bitcoin: uptrend, normal swings, since 12 Oct",
  trend: "uptrend",
  volatility: "normal",
  squeeze: false,
  spellNo: 4,
  spellStartDay: "2026-10-12",
  day: "2026-10-30",
  availableAt: "2026-10-31T00:00:00Z",
  source: "binance",
};
const eth = {
  ...btc,
  asset: "ETH",
  name: "Ethereum",
  text: "Ethereum: sideways, calm swings, squeezing (quiet before a possible big move), since 3 Oct",
  trend: "ranging",
  volatility: "low",
  squeeze: true,
};

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketWeatherPanel companyId="c1" />
      </QueryClientProvider>,
    );
  });
  await settle();
  return { container, root };
}

describe("MarketWeatherPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows one ready-made line per coin and a plain note when a coin is squeezing", async () => {
    tradingApi.marketWeather.mockResolvedValue({ items: [btc, eth] });
    const { container, root } = await render();
    const rows = container.querySelectorAll('[data-testid="market-weather-row"]');
    expect(tradingApi.marketWeather).toHaveBeenCalledWith("c1");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Bitcoin: uptrend, normal swings, since 12 Oct");
    expect(rows[0]?.querySelector('[data-testid="market-weather-squeeze"]')).toBeNull();
    expect(rows[1]?.querySelector('[data-testid="market-weather-squeeze"]')?.textContent).toContain("barely moved");
    const text = (container.textContent ?? "").toLowerCase();
    for (const word of ["buy", "sell", "ready", "promising"]) expect(text).not.toContain(word);
    root.unmount();
  });

  it("explains itself in plain language when there are no labels yet", async () => {
    tradingApi.marketWeather.mockResolvedValue({ items: [] });
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="market-weather-empty"]')?.textContent).toBe(
      "Market weather appears once the price history is stored.",
    );
    expect(container.querySelectorAll('[data-testid="market-weather-row"]')).toHaveLength(0);
    root.unmount();
  });

  it("loads the recent changes for one coin only when asked", async () => {
    tradingApi.marketWeather.mockResolvedValue({ items: [btc] });
    tradingApi.marketWeatherHistory.mockResolvedValue({
      asset: "BTC",
      name: "Bitcoin",
      current: btc,
      spells: [
        { spellNo: 4, startDay: "2026-10-12", endDay: "2026-10-30", days: 19, trend: "uptrend", volatility: "normal", squeeze: false },
        { spellNo: 3, startDay: "2026-10-01", endDay: "2026-10-11", days: 11, trend: "ranging", volatility: "low", squeeze: true },
      ],
      flips: { spells: 4, trend: 2, volatility: 2, squeeze: 1, days: 120 },
      firstDay: "2026-07-03",
    });
    const { container, root } = await render();
    expect(tradingApi.marketWeatherHistory).not.toHaveBeenCalled();
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Show recent changes for Bitcoin");
    await act(async () => {
      button.click();
    });
    await settle();
    expect(tradingApi.marketWeatherHistory).toHaveBeenCalledWith("c1", "BTC", 5);
    const history = container.querySelector('[data-testid="market-weather-history"]')?.textContent ?? "";
    expect(history).toContain("changed 3 times over 120 stored days");
    expect(history).toContain("Going up, normal swings — from 12 Oct, 19 days");
    expect(history).toContain("Moving sideways, calm swings, unusually quiet — from 1 Oct, 11 days");
    root.unmount();
  });

  it("shows a plain error when the weather cannot be loaded", async () => {
    tradingApi.marketWeather.mockRejectedValue(new Error("offline"));
    const { container, root } = await render();
    expect(container.textContent).toContain("Could not load the market weather.");
    root.unmount();
  });
});

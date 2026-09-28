import { describe, expect, it } from "vitest";
import { describeWatcherRule, type WatcherRule } from "@paperclipai/shared";
import { evaluateWatcherRule, watcherRuleHistoryHours, type WatcherRuleInput } from "../services/watcher-rules.js";

/**
 * Watcher rules are evaluated in code, never by a model. These pin what
 * "fires" means for each rule: the window, the threshold (inclusive), the
 * reset after an alert, the source's own reference price, and the level
 * rule firing once per crossing.
 */

const NOW = new Date("2026-09-28T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function input(rule: WatcherRule, price: number, overrides: Partial<WatcherRuleInput> = {}): WatcherRuleInput {
  return {
    rule,
    price,
    observedAt: NOW,
    history: [],
    reference: null,
    lastAlertAt: null,
    lastAlertPrice: null,
    alertedThisCrossing: false,
    ...overrides,
  };
}

const up5in24: WatcherRule = { kind: "change", direction: "up", percent: 5, windowHours: 24 };
const down5in24: WatcherRule = { kind: "change", direction: "down", percent: 5, windowHours: 24 };
const either5in24: WatcherRule = { kind: "change", direction: "either", percent: 5, windowHours: 24 };

describe("percent change within a window", () => {
  it("fires on a rise of exactly the threshold, measured from the lowest price in the window", () => {
    const history = [
      { at: hoursAgo(20), price: 102 },
      { at: hoursAgo(10), price: 100 },
      { at: hoursAgo(2), price: 103 },
    ];
    const outcome = evaluateWatcherRule(input(up5in24, 105, { history }));
    expect(outcome.wantsAlert).toBe(true);
    expect(outcome.basePrice).toBe(100);
    expect(outcome.changePercent).toBeCloseTo(5, 10);
    expect(outcome.windowHours).toBe(24);
  });

  it("does not fire just under the threshold", () => {
    const outcome = evaluateWatcherRule(input(up5in24, 104.99, { history: [{ at: hoursAgo(5), price: 100 }] }));
    expect(outcome.wantsAlert).toBe(false);
    expect(outcome.changePercent).toBeCloseTo(4.99, 5);
  });

  it("ignores prices older than the window", () => {
    const history = [
      { at: hoursAgo(30), price: 90 },
      { at: hoursAgo(12), price: 100 },
    ];
    expect(evaluateWatcherRule(input(up5in24, 103, { history })).wantsAlert).toBe(false);
    const sixHours: WatcherRule = { kind: "change", direction: "up", percent: 5, windowHours: 6 };
    expect(evaluateWatcherRule(input(sixHours, 106, { history: [{ at: hoursAgo(7), price: 100 }] })).wantsAlert).toBe(false);
    expect(evaluateWatcherRule(input(sixHours, 106, { history: [{ at: hoursAgo(5), price: 100 }] })).wantsAlert).toBe(true);
  });

  it("a fall is measured from the highest price, and 'up' ignores falls", () => {
    const history = [
      { at: hoursAgo(8), price: 110 },
      { at: hoursAgo(4), price: 100 },
    ];
    const fell = evaluateWatcherRule(input(down5in24, 104, { history }));
    expect(fell.wantsAlert).toBe(true);
    expect(fell.basePrice).toBe(110);
    expect(fell.changePercent).toBeCloseTo(-5.4545, 3);
    expect(evaluateWatcherRule(input(up5in24, 95, { history: [{ at: hoursAgo(4), price: 110 }] })).wantsAlert).toBe(false);
  });

  it("'either' fires on a rise or a fall and reports the bigger move", () => {
    expect(evaluateWatcherRule(input(either5in24, 94, { history: [{ at: hoursAgo(3), price: 100 }] }))).toMatchObject({
      wantsAlert: true,
      basePrice: 100,
    });
    expect(evaluateWatcherRule(input(either5in24, 106, { history: [{ at: hoursAgo(3), price: 100 }] }))).toMatchObject({
      wantsAlert: true,
      basePrice: 100,
    });
    expect(evaluateWatcherRule(input(either5in24, 103, { history: [{ at: hoursAgo(3), price: 100 }] })).wantsAlert).toBe(false);
  });

  it("a new watcher with no history uses the source's own 24-hour reference", () => {
    const reference = { windowHours: 24, price: 80_000, at: hoursAgo(24) };
    const outcome = evaluateWatcherRule(input(up5in24, 84_000, { reference }));
    expect(outcome).toMatchObject({ wantsAlert: true, basePrice: 80_000 });
    // A reference outside the window (a 6-hour rule) is not used.
    const sixHours: WatcherRule = { kind: "change", direction: "up", percent: 5, windowHours: 6 };
    expect(evaluateWatcherRule(input(sixHours, 84_000, { reference })).wantsAlert).toBe(false);
  });

  it("with no price to compare against, nothing fires", () => {
    expect(evaluateWatcherRule(input(up5in24, 100)).wantsAlert).toBe(false);
  });

  it("after an alert, the next one needs a fresh move from the alert's price", () => {
    const history = [
      { at: hoursAgo(10), price: 100 },
      { at: hoursAgo(1), price: 105.5 },
    ];
    const afterAlert = { lastAlertAt: hoursAgo(2), lastAlertPrice: 105 };
    // 107 is 7% above the window low (100) but only 1.9% above the alert.
    expect(evaluateWatcherRule(input(up5in24, 107, { history, ...afterAlert })).wantsAlert).toBe(false);
    // 110.3 is 5% above the alert price.
    expect(evaluateWatcherRule(input(up5in24, 110.3, { history, ...afterAlert }))).toMatchObject({ wantsAlert: true, basePrice: 105 });
  });

  it("ignores points stamped after the price being evaluated", () => {
    const outcome = evaluateWatcherRule(input(up5in24, 105, { history: [{ at: new Date(NOW.getTime() + 60_000), price: 90 }] }));
    expect(outcome.wantsAlert).toBe(false);
  });
});

describe("price level", () => {
  const above: WatcherRule = { kind: "level", direction: "above", price: 100_000 };
  const below: WatcherRule = { kind: "level", direction: "below", price: 50 };

  it("fires once when the price is on the alert side, then stays quiet for that crossing", () => {
    expect(evaluateWatcherRule(input(above, 100_000))).toMatchObject({ wantsAlert: true, conditionNow: true });
    expect(evaluateWatcherRule(input(above, 101_000, { alertedThisCrossing: true }))).toMatchObject({
      wantsAlert: false,
      conditionNow: true,
    });
    expect(evaluateWatcherRule(input(above, 99_000, { alertedThisCrossing: true }))).toMatchObject({
      wantsAlert: false,
      conditionNow: false,
    });
  });

  it("works for 'below' too", () => {
    expect(evaluateWatcherRule(input(below, 49.5)).wantsAlert).toBe(true);
    expect(evaluateWatcherRule(input(below, 51)).wantsAlert).toBe(false);
  });
});

describe("move since the last alert", () => {
  const since3: WatcherRule = { kind: "since_last_alert", percent: 3 };

  it("measures from the last alert's price, up or down", () => {
    expect(evaluateWatcherRule(input(since3, 103, { lastAlertPrice: 100, lastAlertAt: hoursAgo(50) }))).toMatchObject({
      wantsAlert: true,
      basePrice: 100,
    });
    expect(evaluateWatcherRule(input(since3, 97, { lastAlertPrice: 100, lastAlertAt: hoursAgo(50) })).wantsAlert).toBe(true);
    expect(evaluateWatcherRule(input(since3, 102, { lastAlertPrice: 100, lastAlertAt: hoursAgo(50) })).wantsAlert).toBe(false);
  });

  it("before any alert, measures from the oldest recorded price; with none, nothing fires", () => {
    const history = [
      { at: hoursAgo(3), price: 101 },
      { at: hoursAgo(9), price: 100 },
    ];
    expect(evaluateWatcherRule(input(since3, 103, { history }))).toMatchObject({ wantsAlert: true, basePrice: 100 });
    expect(evaluateWatcherRule(input(since3, 150)).wantsAlert).toBe(false);
  });
});

describe("rule wording and history", () => {
  it("says each rule in one plain sentence", () => {
    expect(describeWatcherRule(up5in24, "Bitcoin")).toBe("Bitcoin rises 5% or more within 24 hours");
    expect(describeWatcherRule(either5in24, "Solana")).toBe("Solana moves 5% or more (up or down) within 24 hours");
    expect(describeWatcherRule({ kind: "change", direction: "down", percent: 2.5, windowHours: 72 }, "ETH")).toBe(
      "ETH falls 2.5% or more within 3 days",
    );
    expect(describeWatcherRule({ kind: "level", direction: "above", price: 100000 }, "Bitcoin")).toBe(
      "Bitcoin goes above $100,000",
    );
    expect(describeWatcherRule({ kind: "level", direction: "below", price: 312.4 }, "DNB", "NOK")).toBe(
      "DNB goes below NOK 312.40",
    );
    expect(describeWatcherRule({ kind: "since_last_alert", percent: 3 }, "AAPL")).toBe(
      "AAPL moves 3% or more (up or down) since the last alert",
    );
  });

  it("keeps history only as long as a window needs", () => {
    expect(watcherRuleHistoryHours(up5in24)).toBe(24);
    expect(watcherRuleHistoryHours({ kind: "level", direction: "above", price: 1 })).toBe(0);
  });
});

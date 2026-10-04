// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { CostSourceCard, costSourceLabel, formatMicroUsd } from "./CostSourceCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(data: Parameters<typeof CostSourceCard>[0]["data"]) {
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(<CostSourceCard data={data} />));
  return el;
}

describe("CostSourceCard", () => {
  it("formats sub-cent amounts with four decimals", () => {
    expect(formatMicroUsd(1_234)).toBe("$0.0012");
    expect(formatMicroUsd(2_500_000)).toBe("$2.50");
  });

  it("labels exact and estimated sources in plain words", () => {
    expect(costSourceLabel("provider").exact).toBe(true);
    expect(costSourceLabel("static_table").label).toMatch(/^Estimated/);
    expect(costSourceLabel("whatever").exact).toBe(false);
  });

  it("shows per-provider totals with exact/estimated tags and a mismatch", () => {
    const el = render({
      sources: [
        { provider: "fal", costSource: "provider", costMicroUsd: 3_000_000, eventCount: 3 },
        { provider: "fal", costSource: "estimate", costMicroUsd: 1_000_000, eventCount: 1 },
        { provider: "openrouter", costSource: "catalogue", costMicroUsd: 500, eventCount: 2 },
      ],
      reconciliation: [
        { provider: "fal", checked: true, trackedMicroUsd: 4_000_000, providerSaysMicroUsd: 4_500_000, differenceMicroUsd: 500_000 },
      ],
    });
    const fal = el.querySelector('[data-testid="cost-provider-fal"]')!;
    expect(fal.textContent).toContain("$4.00");
    expect(fal.textContent).toContain("Exact (from provider)");
    expect(fal.textContent).toContain("Estimated");
    expect(el.querySelector('[data-testid="cost-provider-openrouter"]')!.textContent).toContain("$0.0005");
    const check = el.querySelector('[data-testid="cost-check-fal"]')!;
    expect(check.textContent).toContain("Differs by $0.50");
    expect(check.textContent).toContain("says $4.50");
  });

  it("says not checked yet when no check has run", () => {
    const el = render({ sources: [], reconciliation: [{ provider: "fal", checked: false, trackedMicroUsd: 0, providerSaysMicroUsd: 0, differenceMicroUsd: 0 }] });
    expect(el.textContent).toContain("Not checked yet");
  });

  it("shows the Sogni balance check alongside Fal's", () => {
    const el = render({
      sources: [],
      reconciliation: [
        { provider: "fal", checked: true, trackedMicroUsd: 1_000_000, providerSaysMicroUsd: 1_000_000, differenceMicroUsd: 0 },
        { provider: "sogni", checked: true, trackedMicroUsd: 0, providerSaysMicroUsd: 30_000, differenceMicroUsd: 30_000 },
      ],
    });
    expect(el.querySelector('[data-testid="cost-check-fal"]')!.textContent).toContain("Matches");
    const sogni = el.querySelector('[data-testid="cost-check-sogni"]')!;
    expect(sogni.textContent).toContain("Differs by $0.03");
  });
});

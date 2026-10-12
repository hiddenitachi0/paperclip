// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { IssueProgressBar, issueProgressText, readIssueProgress } from "./IssueProgressBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode) {
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(node));
  return el;
}

describe("IssueProgressBar", () => {
  it("shows count, percent, ETA and plan growth", () => {
    const el = render(
      <IssueProgressBar
        progress={{ completedCount: 5, totalCount: 8, percent: 69, etaLabel: "about 2 h left (≈ 15:40)", planGrewLabel: "plan grew 7 → 8" }}
      />,
    );
    expect(el.textContent).toBe("5 of 8 · 69% · about 2 h left (≈ 15:40) · plan grew 7 → 8");
    expect(el.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("69");
  });

  it("shows no ETA when the server sends none (fewer than 2 done)", () => {
    const el = render(<IssueProgressBar progress={{ completedCount: 1, totalCount: 4, percent: 25, etaLabel: null }} />);
    expect(el.textContent).toBe("1 of 4 · 25%");
  });

  it("renders nothing for tasks without sub-tasks", () => {
    expect(render(<IssueProgressBar progress={null} />).innerHTML).toBe("");
    expect(readIssueProgress({ progress: null })).toBeNull();
    expect(readIssueProgress({ progress: { completedCount: 0, totalCount: 0, percent: 0 } })).toBeNull();
  });

  it("uses plain wording when only the size of the plan grew", () => {
    expect(
      issueProgressText({ completedCount: 1, totalCount: 3, percent: 33, planGrewLabel: "plan grew 3 → 5 (weight)" }),
    ).toBe("1 of 3 · 33% · plan got bigger");
  });
});

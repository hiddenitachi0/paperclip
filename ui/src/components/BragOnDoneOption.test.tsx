// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BragOnDoneOption } from "./BragOnDoneOption";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("BragOnDoneOption on an existing task", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const box = () => container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  const pre = { approvedByUserId: "u", approvedAt: "2026-10-17T00:00:00.000Z", maxCostCents: 39, lengthSeconds: 30 };

  it("lets the person untick it while the task is not done", () => {
    const onChange = vi.fn();
    act(() => root.render(<BragOnDoneOption company={{}} checked preapproval={pre} onCheckedChange={onChange} />));
    expect(box().disabled).toBe(false);
    act(() => box().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("is locked once the task is done", () => {
    act(() => root.render(<BragOnDoneOption company={{}} checked preapproval={pre} taskDone onCheckedChange={() => {}} />));
    expect(box().disabled).toBe(true);
    expect(container.textContent).toContain("can no longer be changed");
  });

  it("shows what happened once the video was made", () => {
    act(() => root.render(
      <BragOnDoneOption company={{}} checked preapproval={{ ...pre, triggeredAt: "2026-10-18T00:00:00.000Z", outcome: "completed" }} onCheckedChange={() => {}} />,
    ));
    expect(box().disabled).toBe(true);
    expect(container.textContent).toContain("The brag video for this task was made");
  });

  it("keeps an existing tick removable even after the company turned the feature off", () => {
    const onChange = vi.fn();
    act(() => root.render(<BragOnDoneOption company={{ bragOnDoneEnabled: false }} checked preapproval={pre} onCheckedChange={onChange} />));
    expect(box().disabled).toBe(false);
    expect(container.textContent).toContain("turned off for this company");
  });
});

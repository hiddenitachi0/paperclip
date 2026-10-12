// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  HELPER_APPLY_EVENT,
  applyHelperAnswer,
  canApplyHelperAnswer,
  extractApplicableText,
  listHelperApplyTargets,
  registerHelperApplyTarget,
  resetHelperApplyRegistryForTests,
  useHelperApplyTarget,
  type HelperApplyEventDetail,
} from "./helper-apply";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetHelperApplyRegistryForTests();
});

function Field({ label, enabled = true }: { label: string; enabled?: boolean }) {
  const [value, setValue] = useState("before");
  useHelperApplyTarget(label, setValue, enabled);
  return <textarea data-testid="field" value={value} onChange={(e) => setValue(e.target.value)} />;
}

function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

describe("helper apply registry", () => {
  it("sets a registered field through its own state setter and unregisters on unmount", () => {
    render(<Field label="Instructions" />);
    expect(listHelperApplyTargets()).toEqual(["Instructions"]);
    let ok = false;
    act(() => {
      ok = applyHelperAnswer("Instructions", "after");
    });
    expect(ok).toBe(true);
    expect((host!.querySelector("[data-testid=field]") as HTMLTextAreaElement).value).toBe("after");
    act(() => root!.unmount());
    root = null;
    expect(listHelperApplyTargets()).toEqual([]);
    expect(applyHelperAnswer("Instructions", "x", null)).toBe(false);
  });

  it("does not register a disabled field", () => {
    render(<Field label="Instructions" enabled={false} />);
    expect(listHelperApplyTargets()).toEqual([]);
  });

  it("the latest registration wins, and the earlier one comes back when it leaves", () => {
    const calls: string[] = [];
    const offA = registerHelperApplyTarget("X", (v) => calls.push(`a:${v}`));
    const offB = registerHelperApplyTarget("X", (v) => calls.push(`b:${v}`));
    applyHelperAnswer("X", "1", null);
    offB();
    applyHelperAnswer("X", "2", null);
    offA();
    expect(calls).toEqual(["b:1", "a:2"]);
  });

  it("falls back to an event on the add-on's element, which must claim it", () => {
    const el = document.createElement("div");
    el.setAttribute("data-helper-apply", "Character sheet: Hair");
    document.body.appendChild(el);
    expect(canApplyHelperAnswer("Character sheet: Hair")).toBe(true);
    expect(applyHelperAnswer("Character sheet: Hair", "blonde")).toBe(false); // nobody listening
    const got: string[] = [];
    el.addEventListener(HELPER_APPLY_EVENT, (event) => {
      const detail = (event as CustomEvent<HelperApplyEventDetail>).detail;
      got.push(detail.value);
      detail.handled = true;
    });
    expect(applyHelperAnswer("Character sheet: Hair", "blonde")).toBe(true);
    expect(got).toEqual(["blonde"]);
    expect(el.textContent).toBe("");
    el.remove();
    expect(canApplyHelperAnswer("Character sheet: Hair")).toBe(false);
  });

  it("applies the first fenced block of an answer, else the whole answer", () => {
    expect(extractApplicableText("Here you go:\n```\nYou are the front desk.\nBe brief.\n```\nPress Save.")).toBe(
      "You are the front desk.\nBe brief.",
    );
    expect(extractApplicableText("  Just this.  ")).toBe("Just this.");
  });
});

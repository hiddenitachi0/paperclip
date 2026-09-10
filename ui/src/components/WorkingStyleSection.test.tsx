// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answersStraightAwayInChat,
  DEFAULT_WORKING_STYLE,
  WorkingStyleSection,
  workingStyleTitle,
  WORKING_STYLE_OPTIONS,
} from "./WorkingStyleSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("working style choice (DUR-3971)", () => {
  it("defaults to the working agent, which is what every hire did before", () => {
    expect(DEFAULT_WORKING_STYLE).toBe("works_on_tasks");
    expect(answersStraightAwayInChat(DEFAULT_WORKING_STYLE)).toBe(false);
  });

  it("only the chat option asks for the quick lane", () => {
    expect(answersStraightAwayInChat("answers_in_chat")).toBe(true);
    expect(answersStraightAwayInChat("works_on_tasks")).toBe(false);
  });

  it("reads the stored flag back in the same words it was offered in", () => {
    expect(workingStyleTitle(true)).toBe("Also answers straight away in chat");
    expect(workingStyleTitle(false)).toBe("Goes away and works on tasks");
    // A hire card from before this choice existed carries no flag at all.
    expect(workingStyleTitle(undefined)).toBe("Goes away and works on tasks");
  });

  it("says what each option does in plain words, with no internal names", () => {
    for (const option of WORKING_STYLE_OPTIONS) {
      expect(option.line.length).toBeGreaterThan(20);
      const text = `${option.title} ${option.line}`.toLowerCase();
      for (const jargon of ["lane", "lane a", "lane_a", "adapter", "flag", "api", "agent"]) {
        expect(text).not.toContain(jargon);
      }
    }
  });
});

describe("WorkingStyleSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function radios() {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("[role='radio']"));
  }

  it("shows both options and marks the current one", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <WorkingStyleSection value="works_on_tasks" onChange={() => {}} />,
      );
    });

    const options = radios();
    expect(options).toHaveLength(2);
    expect(container.textContent).toContain("Goes away and works on tasks");
    expect(container.textContent).toContain("Also answers straight away in chat");
    expect(options[0].getAttribute("aria-checked")).toBe("true");
    expect(options[1].getAttribute("aria-checked")).toBe("false");

    act(() => root.unmount());
  });

  it("reports the chat option when the operator picks it", () => {
    const onChange = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(<WorkingStyleSection value="works_on_tasks" onChange={onChange} />);
    });

    act(() => {
      radios()[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("answers_in_chat");

    act(() => root.unmount());
  });

  it("tells the operator the choice is not final", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<WorkingStyleSection value="answers_in_chat" onChange={() => {}} />);
    });

    expect(container.textContent).toContain("You can change this later");

    act(() => root.unmount());
  });
});

/**
 * The quick-agent flag is ADDITIVE — nothing gates task assignment, heartbeats
 * or lane-B routing on it. An earlier draft of this component told the operator
 * a quick agent "cannot take a job and work through it itself", which is simply
 * untrue and would have made him avoid the option for roles it suits fine.
 *
 * Wrong operator text is not a cosmetic bug: it is the operator making a worse
 * decision because we told him something false. This pins the claim rather than
 * the phrasing, so the wording can still be improved.
 */
describe("the working-style options tell the truth", () => {
  it("never claims a quick agent cannot be given jobs", () => {
    const prose = WORKING_STYLE_OPTIONS.map((o) => `${o.title} ${o.line}`).join(" ").toLowerCase();
    for (const lie of [
      "cannot take a job",
      "can not take a job",
      "cannot be given",
      "instead of working on tasks",
      "not able to take",
    ]) {
      expect(prose).not.toContain(lie);
    }
  });

  it("says out loud that the chat option is an addition, not a replacement", () => {
    const chat = WORKING_STYLE_OPTIONS.find((o) => o.value === "answers_in_chat")!;
    expect(`${chat.title} ${chat.line}`.toLowerCase()).toMatch(/also|as well|still be given/);
  });
});

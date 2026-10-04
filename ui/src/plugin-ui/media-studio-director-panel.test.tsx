// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdvancedFeaturesToggle,
  AiDirectorSection,
  type DirectorConversation,
  type DirectorShot,
} from "../../../packages/plugins/media-studio/src/ui/director-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenes = [{ id: "sc1", orderIndex: 0, title: "Opening" }];
const baseShot: DirectorShot = { id: "sh1", sceneId: "sc1", orderIndex: 0, prompt: "A man walks", cameraNotes: null, durationSeconds: 5 };

function convo(status: DirectorConversation["status"], extra: DirectorConversation["messages"] = []): DirectorConversation {
  const review = {
    id: "m1", role: "director" as const, kind: "review" as const, createdAt: "2026-01-01T00:00:00Z",
    payload: {
      summary: "Needs more detail.",
      shotFindings: [{ shotId: "sh1", sceneId: "sc1", orderIndex: 0, issues: ["Time of day is missing"] }],
      contradictions: ["His coat changes colour"],
      continuityRisks: ["Lighting may jump"],
    },
  };
  return { id: "c1", status, messages: [review, ...extra] };
}

function questionMsg(): DirectorConversation["messages"][number] {
  return {
    id: "m2", role: "director", kind: "question", createdAt: "2026-01-01T00:01:00Z",
    payload: {
      doneAsking: false,
      questions: [
        { id: "q1", shotId: "sh1", prompt: "What time of day?", options: [{ id: "o1", label: "Morning" }, { id: "o2", label: "Night" }] },
        { id: "q2", shotId: null, prompt: "What is the mood?", options: [] },
      ],
    },
  };
}

let host: HTMLDivElement;
let root: Root;

async function mount(opts: { conversation: DirectorConversation | null; shots?: DirectorShot[]; fetchJson?: ReturnType<typeof vi.fn>; editable?: boolean }) {
  const fetchJson =
    opts.fetchJson ??
    vi.fn(async (path: string) => {
      if (path.endsWith("/director/conversation")) {
        if (!opts.conversation) throw new Error("none");
        return opts.conversation;
      }
      return {};
    });
  await act(async () => {
    root.render(
      <AiDirectorSection
        companyId="co"
        storylineId="sl"
        scenes={scenes}
        shots={opts.shots ?? [baseShot]}
        editable={opts.editable ?? true}
        fetchJson={fetchJson as never}
        onShotsChanged={async () => {}}
      />,
    );
  });
  return fetchJson;
}

const byText = (text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

async function click(el: Element | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function callsTo(fetchJson: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchJson.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("AI director section", () => {
  it("shows the start button and runs the review", async () => {
    const fetchJson = await mount({ conversation: null });
    await click(byText("Improve with AI director"));
    expect(callsTo(fetchJson, "/director/review")[0][1]).toMatchObject({ method: "POST" });
  });

  it("renders the review in plain language", async () => {
    await mount({ conversation: convo("asking") });
    const text = host.querySelector("[data-testid=director-review]")!.textContent!;
    expect(text).toContain("Needs more detail.");
    expect(text).toContain("Scene 1, shot 1");
    expect(text).toContain("Time of day is missing");
    expect(text).toContain("His coat changes colour");
    expect(text).toContain("Lighting may jump");
  });

  it("answers a multiple-choice question and a free-text question", async () => {
    const fetchJson = await mount({ conversation: convo("asking", [questionMsg()]) });
    await click(byText("Night"));
    const ta = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "Tense");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byText("Send my answers"));
    const body = JSON.parse(callsTo(fetchJson, "/conversation/answer")[0][1].body);
    expect(body).toEqual({
      goodEnough: false,
      answers: [
        { questionId: "q1", youDecide: false, selectedOptionId: "o2", answerText: null },
        { questionId: "q2", youDecide: false, selectedOptionId: null, answerText: "Tense" },
      ],
    });
  });

  it("sends 'you decide' for a question", async () => {
    const fetchJson = await mount({ conversation: convo("asking", [questionMsg()]) });
    await click(byText("You decide"));
    await click(byText("Send my answers"));
    const body = JSON.parse(callsTo(fetchJson, "/conversation/answer")[0][1].body);
    expect(body.answers).toEqual([{ questionId: "q1", youDecide: true, selectedOptionId: null, answerText: null }]);
  });

  it("'Good enough, stop asking' is always available and ends the chat", async () => {
    const fetchJson = await mount({ conversation: convo("asking", [questionMsg()]) });
    await click(byText("Good enough, stop asking"));
    const body = JSON.parse(callsTo(fetchJson, "/conversation/answer")[0][1].body);
    expect(body.goodEnough).toBe(true);
  });

  const pendingShot: DirectorShot = {
    ...baseShot,
    proposalStatus: "pending",
    proposedPrompt: "A tired man walks down a rainy street at night",
    proposedCameraNotes: "Slow tracking shot",
    proposedDurationSeconds: 8,
    proposedTransitionIn: "fade",
  };

  it("shows original and proposed side by side, and accepts a shot", async () => {
    const fetchJson = await mount({ conversation: convo("proposing"), shots: [pendingShot] });
    const text = host.querySelector("[data-testid=proposal-sh1]")!.textContent!;
    expect(text).toContain("A man walks");
    expect(text).toContain("A tired man walks down a rainy street at night");
    expect(text).toContain("8 seconds");
    expect(text).toContain("Fade");
    await click(byText("Accept"));
    expect(callsTo(fetchJson, "/director/proposals/sh1/accept")).toHaveLength(1);
  });

  it("rejects a shot and accepts all", async () => {
    const fetchJson = await mount({ conversation: convo("proposing"), shots: [pendingShot] });
    await click(byText("Keep mine"));
    expect(callsTo(fetchJson, "/director/proposals/sh1/reject")).toHaveLength(1);
    await click(byText("Accept all"));
    expect(callsTo(fetchJson, "/director/proposals/accept-all")).toHaveLength(1);
  });

  it("edits a proposal before using it", async () => {
    const fetchJson = await mount({ conversation: convo("proposing"), shots: [pendingShot] });
    await click(byText("Edit"));
    const ta = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "My own version");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byText("Save my changes and use this"));
    const body = JSON.parse(callsTo(fetchJson, "/director/proposals/sh1/edit")[0][1].body);
    expect(body).toEqual({ prompt: "My own version", cameraNotes: "Slow tracking shot", durationSeconds: 8, transitionIn: "fade" });
  });

  it("offers Restore original once a shot has prompt history", async () => {
    const improved: DirectorShot = { ...baseShot, prompt: "New wording", promptHistory: [{ prompt: "A man walks" }] };
    const fetchJson = await mount({ conversation: convo("done"), shots: [improved] });
    await click(byText("Restore original"));
    expect(callsTo(fetchJson, "/shots/sh1/restore-prompt")).toHaveLength(1);
    expect(host.querySelector("[data-testid=director-done]")).toBeTruthy();
  });

  it("hides Restore original when there is no history", async () => {
    await mount({ conversation: convo("done") });
    expect(byText("Restore original")).toBeUndefined();
  });
});

describe("Advanced features toggle", () => {
  it("shows a plain-language explainer and reports changes", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<AdvancedFeaturesToggle enabled={false} busy={false} error={null} onChange={onChange} />);
    });
    expect(host.textContent).toContain("Advanced features");
    expect(host.textContent).toContain("Adds the AI director");
    await act(async () => {
      host.querySelector("input")!.click();
    });
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

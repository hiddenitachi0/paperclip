// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { QuickAgentChatPanel } from "./QuickAgentChatPanel";

/**
 * "Continue earlier conversation…": the same thing Telegram's /cont does. The
 * panel asks what to continue, starts the new conversation on the server,
 * remembers it for the next message, and says what it carries on from.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";

const mockLaneAApi = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getConversation: vi.fn(),
  continueConversation: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../api/laneA", () => ({ laneAApi: mockLaneAApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockLaneAApi.sendMessage.mockReset();
  mockLaneAApi.getConversation.mockReset();
  mockLaneAApi.continueConversation.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  await act(async () => {
    const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function continueWith(spec: string) {
  await act(async () => {
    root.render(<QuickAgentChatPanel agentId={AGENT} agentName="Maja" companyId={COMPANY} />);
  });
  await act(async () => {
    button("Continue earlier conversation…").click();
  });
  const input = container.querySelector<HTMLInputElement>('input[aria-label="What to continue"]')!;
  expect(input).not.toBeNull();
  if (spec) await typeInto(input, spec);
  await act(async () => {
    button("Continue").click();
  });
  await flush();
}

describe("QuickAgentChatPanel continue", () => {
  it("starts the continued conversation, says what it carries on from, and the next message uses it", async () => {
    mockLaneAApi.continueConversation.mockResolvedValue({
      conversationId: CONVERSATION,
      mode: "time",
      recap: "the last 45 minutes (2 messages).",
      matchedMessages: 2,
      consideredMessages: 2,
      fromConversations: 1,
    });
    mockLaneAApi.sendMessage.mockResolvedValue({
      conversationId: CONVERSATION,
      response: "Right, where we left off.",
      turnCount: 1,
      stopReason: "end_turn",
      actions: [],
    });

    await continueWith("last 45 minutes");

    expect(mockLaneAApi.continueConversation).toHaveBeenCalledWith(AGENT, { companyId: COMPANY, spec: "last 45 minutes" });
    expect(container.textContent).toContain("Continuing from: the last 45 minutes (2 messages).");
    expect(container.querySelector('input[aria-label="What to continue"]')).toBeNull();
    expect(window.sessionStorage.getItem(`paperclip.quickAgent.conversation.${AGENT}`)).toBe(CONVERSATION);

    await typeInto(container.querySelector("textarea")!, "where were we?");
    await act(async () => {
      button("Send").click();
    });
    await flush();
    expect(mockLaneAApi.sendMessage).toHaveBeenCalledWith(AGENT, {
      companyId: COMPANY,
      message: "where were we?",
      conversationId: CONVERSATION,
    });
  });

  it("an empty box continues the last conversation", async () => {
    mockLaneAApi.continueConversation.mockResolvedValue({ conversationId: CONVERSATION, mode: "last", recap: "x" });
    await continueWith("");
    expect(mockLaneAApi.continueConversation).toHaveBeenCalledWith(AGENT, { companyId: COMPANY });
  });

  it("shows a refusal in plain words and keeps nothing", async () => {
    mockLaneAApi.continueConversation.mockRejectedValue(
      new ApiError("I found no messages with Maja from the last 30 minutes, so there is nothing to continue.", 422, {
        code: "LANE_A_CONTINUE_NOTHING_FOUND",
      }),
    );
    await continueWith("last 30 minutes");
    expect(container.textContent).toContain("I found no messages with Maja from the last 30 minutes");
    expect(window.sessionStorage.getItem(`paperclip.quickAgent.conversation.${AGENT}`)).toBeNull();
  });

  it("a resumed continued conversation says what it carries on from", async () => {
    window.sessionStorage.setItem(`paperclip.quickAgent.conversation.${AGENT}`, CONVERSATION);
    mockLaneAApi.getConversation.mockResolvedValue({
      conversationId: CONVERSATION,
      turnCount: 0,
      expired: false,
      turnCapReached: false,
      continuedFrom: "Preparing the Jacsped meeting.",
      messages: [],
    });
    await act(async () => {
      root.render(<QuickAgentChatPanel agentId={AGENT} agentName="Maja" companyId={COMPANY} />);
    });
    await flush();
    expect(container.textContent).toContain("Continuing from: Preparing the Jacsped meeting.");
  });
});

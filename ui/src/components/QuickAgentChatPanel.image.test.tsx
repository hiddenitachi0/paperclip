// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAgentChatPanel } from "./QuickAgentChatPanel";

/**
 * A quick agent's reply can carry a picture a tool made (Media Studio's
 * "Generate image" without a task). The chat shows it inline, opens it full
 * size on click, and links to it in Files; a reply without one looks as before.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";

const mockLaneAApi = vi.hoisted(() => ({ sendMessage: vi.fn(), getConversation: vi.fn() }));

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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function sendAndWait(text: string) {
  await act(async () => {
    root.render(<QuickAgentChatPanel agentId={AGENT} agentName="Maja" companyId={COMPANY} />);
  });
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = [...container.querySelectorAll("button")].find((b) => b.textContent === "Send")!;
  await act(async () => {
    send.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("QuickAgentChatPanel pictures", () => {
  it("shows a picture from the reply inline, full size on click, with a link to Files", async () => {
    mockLaneAApi.sendMessage.mockResolvedValue({
      conversationId: CONVERSATION,
      response: "Here is the sofa picture.",
      turnCount: 1,
      stopReason: "end_turn",
      actions: [
        {
          tool: "paperclip_media-studio__generate-image",
          summary: "Made a picture with the Generate image (Media Studio) add-on tool and saved it to Files.",
          ok: true,
          image: {
            fileId: FILE,
            contentPath: `/api/attachments/${FILE}/content`,
            contentType: "image/jpeg",
            seed: 4242,
            issueId: null,
          },
        },
      ],
    });

    await sendAndWait("make a picture of a sofa");

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(`/api/attachments/${FILE}/content`);
    const opener = img?.closest("a");
    expect(opener?.getAttribute("href")).toBe(`/api/attachments/${FILE}/content`);
    expect(opener?.getAttribute("target")).toBe("_blank");
    const filesLink = [...container.querySelectorAll("a")].find((a) => a.textContent === "See it in Files");
    expect(filesLink?.getAttribute("href")).toBe("/files?groupIssueId=no-task");
    expect(container.textContent).toContain("Seed 4242");
  });

  it("shows no picture for a plain reply", async () => {
    mockLaneAApi.sendMessage.mockResolvedValue({
      conversationId: CONVERSATION,
      response: "It is sunny.",
      turnCount: 1,
      stopReason: "end_turn",
      actions: [{ tool: "get_weather", summary: "Looked up the weather.", ok: true }],
    });

    await sendAndWait("weather?");

    expect(container.textContent).toContain("It is sunny.");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("See it in Files");
  });
});

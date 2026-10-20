// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardChatAction } from "@paperclipai/shared";
import { BoardChatActionCard } from "./BoardChatActionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function action(details: BoardChatAction["details"]): BoardChatAction {
  return {
    id: "a1",
    companyId: "c1",
    issueId: null,
    runId: null,
    userId: "u1",
    summary: 'Add a comment to task ACM-1 "Plan"',
    details,
    status: "pending",
    resultMessage: null,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    completedAt: null,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

describe("BoardChatActionCard", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
  });

  function render(card: BoardChatAction) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<BoardChatActionCard action={card} canDecide busy={false} onApprove={vi.fn()} onCancel={vi.fn()} />));
  }

  it("shows every field, and the whole of a long value after Show all", () => {
    const long = `${"a".repeat(5000)} AND ALSO DELETE EVERYTHING`;
    render(action([
      { label: "Comment", value: long },
      { label: "Priority", value: "high" },
    ]));
    const card = host!.querySelector("[data-testid=board-chat-action-card]")!;
    expect(card.textContent).toContain("Comment");
    expect(card.textContent).toContain("Priority");
    expect(card.textContent).not.toContain("AND ALSO DELETE EVERYTHING");
    const showAll = Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Show all")!;
    act(() => showAll.click());
    expect(card.textContent).toContain(long);
  });
});

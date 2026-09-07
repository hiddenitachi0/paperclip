// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { FeedCard } from "./FeedCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "event-1",
    companyId: "company-1",
    actorType: "user",
    actorId: "user-1",
    action: "approval.rejected",
    entityType: "approval",
    entityId: "approval-1",
    agentId: null,
    runId: null,
    details: null,
    createdAt: new Date(),
    ...overrides,
  } as ActivityEvent;
}

function renderCard(event: ActivityEvent) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <FeedCard
        event={event}
        agentMap={new Map<string, Agent>()}
        entityNameMap={new Map()}
        entityTitleMap={new Map([["approval:approval-1", "Merge the invoice fix"]])}
      />,
    );
  });
  return container;
}

// DUR-283: the reason an operator gave with an approval decision must be
// readable from the feed entry itself, not only on the approval page.
describe("FeedCard approval decision note (DUR-283)", () => {
  it("shows the decision note under a rejection", () => {
    const host = renderCard(
      makeEvent({
        details: { type: "merge_pr", decisionNote: "The migration drops a column we still read." },
      }),
    );
    expect(host.querySelector('[data-fc="verb"]')?.textContent).toBe("rejected");
    const note = host.querySelector('[data-fc="decision-note"]');
    expect(note?.textContent).toContain("Decision note.");
    expect(note?.textContent).toContain("The migration drops a column we still read.");
  });

  it("shows the decision note under a revision request and an approval", () => {
    const revision = renderCard(
      makeEvent({
        action: "approval.revision_requested",
        details: { type: "request_board_approval", decisionNote: "Add the total cost first." },
      }),
    );
    expect(revision.querySelector('[data-fc="verb"]')?.textContent).toBe("requested changes on");
    expect(revision.querySelector('[data-fc="decision-note"]')?.textContent).toContain("Add the total cost first.");

    act(() => root?.unmount());
    revision.remove();

    const approved = renderCard(
      makeEvent({
        action: "approval.approved",
        details: { type: "merge_pr", decisionNote: "Looks good, ship it." },
      }),
    );
    expect(approved.querySelector('[data-fc="decision-note"]')?.textContent).toContain("Looks good, ship it.");
  });

  it("renders no note block when the decision had no note", () => {
    const host = renderCard(makeEvent({ details: { type: "merge_pr", decisionNote: null } }));
    expect(host.querySelector('[data-fc="decision-note"]')).toBeNull();
    expect(host.querySelector('[data-fc="verb"]')?.textContent).toBe("rejected");
  });

  it("ignores a decisionNote on an entry that is not an approval decision", () => {
    const host = renderCard(
      makeEvent({
        action: "approval.created",
        details: { type: "merge_pr", decisionNote: "should not show" },
      }),
    );
    expect(host.querySelector('[data-fc="decision-note"]')).toBeNull();
  });

  it("describes the per-issue mirror of a decision in plain words with its note", () => {
    const host = renderCard(
      makeEvent({
        action: "issue.approval_rejected",
        entityType: "issue",
        entityId: "issue-1",
        details: { approvalId: "approval-1", approvalType: "merge_pr", decisionNote: "Not this week." },
      }),
    );
    expect(host.querySelector('[data-fc="verb"]')?.textContent).toBe("rejected an approval request on");
    expect(host.querySelector('[data-fc="decision-note"]')?.textContent).toContain("Not this week.");
  });
});

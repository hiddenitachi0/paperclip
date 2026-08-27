// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Approval, Issue } from "@paperclipai/shared";
import { ApprovalCard } from "./ApprovalCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: { title: "who made each file, a real PDF viewer" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function issue(identifier: string): Issue {
  return { id: identifier, identifier } as Issue;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderCard(props: Partial<React.ComponentProps<typeof ApprovalCard>>) {
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <ApprovalCard approval={makeApproval()} requesterAgent={null} {...props} />
      </MemoryRouter>,
    );
  });
}

describe("ApprovalCard ticket identification (DUR-211)", () => {
  it("leads the title with the linked ticket identifier", () => {
    renderCard({ linkedIssues: [issue("DUR-204")] });
    expect(container.textContent).toContain("DUR-204");
    // Ticket ref must appear before the subject text in reading order.
    const ticketIndex = container.textContent!.indexOf("DUR-204");
    const subjectIndex = container.textContent!.indexOf("who made each file");
    expect(ticketIndex).toBeGreaterThanOrEqual(0);
    expect(ticketIndex).toBeLessThan(subjectIndex);
  });

  it("lists every linked ticket when several are attached", () => {
    renderCard({ linkedIssues: [issue("DUR-204"), issue("DUR-210")] });
    expect(container.textContent).toContain("DUR-204");
    expect(container.textContent).toContain("DUR-210");
  });

  it("flags an approval with zero linked tickets as a defect instead of showing nothing", () => {
    renderCard({ linkedIssues: [] });
    expect(container.textContent).toContain("No linked ticket");
  });

  it("does not show a ticket section when the caller hasn't resolved links yet", () => {
    renderCard({ linkedIssues: undefined });
    expect(container.textContent).not.toContain("No linked ticket");
  });

  it("shows the company without opening the card", () => {
    renderCard({ linkedIssues: [issue("DUR-204")], companyName: "Durkan Agency" });
    expect(container.textContent).toContain("Durkan Agency");
  });

  it("keeps commit/PR technical references present but out of the headline", () => {
    renderCard({
      linkedIssues: [issue("DUR-204")],
      approval: makeApproval({
        payload: {
          title: "who made each file, a real PDF viewer",
          technicalReference: "Technical reference: fork repo, pull request #131, commit 82855c76",
        },
      }),
    });
    const text = container.textContent!;
    expect(text).toContain("pull request #131");
    // The technical reference must trail the ticket id / subject, not lead them.
    expect(text.indexOf("DUR-204")).toBeLessThan(text.indexOf("pull request #131"));
  });
});

describe("ApprovalCard deploy branch warning (DUR-226)", () => {
  it("warns in the title row when the commit is not on the project's deploy branch", () => {
    renderCard({
      linkedIssues: [issue("DUR-217")],
      approval: makeApproval({
        type: "request_board_approval",
        payload: {
          title: "DUR-217 merged via PR #143",
          kind: "deploy",
          commit: "d55e5704",
          sourceBranch: "master",
          deployBranch: "custom",
        },
      }),
    });
    expect(container.textContent).toContain("Not on custom");
    expect(container.textContent).toContain("this commit is on master");
  });

  it("shows a plain 'deploys from' badge when the branch matches, with no warning", () => {
    renderCard({
      linkedIssues: [issue("DUR-217")],
      approval: makeApproval({
        payload: {
          title: "DUR-217 merged via PR #143",
          kind: "deploy",
          commit: "abc1234",
          sourceBranch: "custom",
          deployBranch: "custom",
        },
      }),
    });
    expect(container.textContent).toContain("Deploys from custom");
    expect(container.textContent).not.toContain("Not on");
  });

  it("shows nothing when the backend hasn't resolved a source branch yet", () => {
    renderCard({
      linkedIssues: [issue("DUR-217")],
      approval: makeApproval({
        payload: { title: "DUR-217 merged via PR #143", kind: "deploy", commit: "abc1234" },
      }),
    });
    expect(container.textContent).not.toContain("Deploys from");
    expect(container.textContent).not.toContain("Not on");
  });
});

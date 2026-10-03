import { describe, expect, it } from "vitest";
import { personIsAssignedToQuickAgent } from "../services/lane-a.js";
import type { AuthorizationActor } from "../services/authorization.js";

const companyId = "11111111-1111-4111-8111-111111111112";
const otherCompanyId = "22222222-2222-4222-8222-222222222223";
const ownerUserId = "owner-1";
const assignedUserId = "assigned-1";
const strangerUserId = "stranger-1";

function boardActor(overrides: Partial<AuthorizationActor> = {}): AuthorizationActor {
  return {
    type: "board",
    userId: strangerUserId,
    source: "session",
    isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: "member", status: "active" }],
    ...overrides,
  };
}

describe("personIsAssignedToQuickAgent (DUR-4070)", () => {
  it("allows an agent-actor requester (colleague hand-off) regardless of assignment", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: null, agentId: "colleague-agent" },
        actor: boardActor(),
      }),
    ).toBe(true);
  });

  it("refuses a company member who is neither the owner nor assigned", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [assignedUserId],
        requester: { userId: strangerUserId, agentId: null },
        actor: boardActor({ userId: strangerUserId }),
      }),
    ).toBe(false);
  });

  it("allows a person on the assigned list", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [assignedUserId],
        requester: { userId: assignedUserId, agentId: null },
        actor: boardActor({ userId: assignedUserId }),
      }),
    ).toBe(true);
  });

  it("always allows the company's owner, even with an empty assignment list", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: ownerUserId, agentId: null },
        actor: boardActor({
          userId: ownerUserId,
          memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        }),
      }),
    ).toBe(true);
  });

  it("does not treat an owner membership in a DIFFERENT company as owner here", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: strangerUserId, agentId: null },
        actor: boardActor({
          userId: strangerUserId,
          memberships: [{ companyId: otherCompanyId, membershipRole: "owner", status: "active" }],
        }),
      }),
    ).toBe(false);
  });

  it("does not let a REVOKED/inactive owner membership bypass the assignment list", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: strangerUserId, agentId: null },
        actor: boardActor({
          userId: strangerUserId,
          memberships: [{ companyId, membershipRole: "owner", status: "revoked" }],
        }),
      }),
    ).toBe(false);
  });

  it("always allows the local single-operator deployment actor (source local_implicit)", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: "local-board", agentId: null },
        actor: boardActor({ userId: "local-board", source: "local_implicit", memberships: [] }),
      }),
    ).toBe(true);
  });

  it("always allows an instance admin", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: strangerUserId, agentId: null },
        actor: boardActor({ userId: strangerUserId, isInstanceAdmin: true, memberships: [] }),
      }),
    ).toBe(true);
  });

  it("treats a board_delegate actor the same as the board actor it delegates for", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: strangerUserId, agentId: null },
        actor: boardActor({ type: "board_delegate", userId: strangerUserId }),
      }),
    ).toBe(false);
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [assignedUserId],
        requester: { userId: assignedUserId, agentId: null },
        actor: boardActor({ type: "board_delegate", userId: assignedUserId }),
      }),
    ).toBe(true);
  });

  it("does not restrict a non-board, non-board_delegate actor (e.g. an agent-key caller) or a missing actor", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: null, agentId: null },
        actor: { type: "agent", agentId: "caller-agent", companyId, source: "agent_key" },
      }),
    ).toBe(true);
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [],
        requester: { userId: strangerUserId, agentId: null },
        actor: undefined,
      }),
    ).toBe(true);
  });

  it("fails open (allows) when the requester carries no userId at all, since there is nothing to check against the list", () => {
    expect(
      personIsAssignedToQuickAgent({
        companyId,
        assignedUserIds: [assignedUserId],
        requester: { userId: null, agentId: null },
        actor: boardActor({ userId: null }),
      }),
    ).toBe(true);
  });
});

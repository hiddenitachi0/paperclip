// DUR-148: role-mutating functions in services/agent-roles.ts (assignRoleToAgent,
// addAgentToolOverride, removeAgentToolOverride, addAgentRightOverride,
// removeAgentRightOverride) must refuse a non-board actor and refuse
// actor==target (self-assignment/self-override), independent of the
// assertBoard/self-check already enforced at the route layer
// (routes/agent-roles.ts) — so a caller that reaches these functions
// directly (a future route, a script, or an import path) cannot bypass the
// board-only guard the way the pre-DUR-148 assignRoleToAgent could.
//
// Every case below is rejected before any database access, so a dummy `db`
// object (never actually used) is enough — no embedded Postgres needed.
import { describe, expect, it } from "vitest";
import {
  assignRoleToAgent,
  addAgentToolOverride,
  removeAgentToolOverride,
  addAgentRightOverride,
  removeAgentRightOverride,
} from "../services/agent-roles.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const roleId = "33333333-3333-4333-8333-333333333333";
const unusedDb = {} as never;

describe("agent-roles service — board-only + no-self-assignment guard", () => {
  it("assignRoleToAgent rejects a non-board actor", async () => {
    await expect(
      assignRoleToAgent(unusedDb, agentId, roleId, { actor: { type: "agent", agentId: "peer-agent" } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("assignRoleToAgent rejects an agent assigning a role to itself, even if mislabeled as board", async () => {
    await expect(
      assignRoleToAgent(unusedDb, agentId, roleId, { actor: { type: "board", agentId } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("assignRoleToAgent rejects a missing actor", async () => {
    await expect(
      assignRoleToAgent(unusedDb, agentId, roleId, {} as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("addAgentToolOverride rejects a non-board actor", async () => {
    await expect(
      addAgentToolOverride(unusedDb, agentId, { name: "github-mcp" }, { type: "agent", agentId: "peer-agent" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("addAgentToolOverride rejects self-targeting", async () => {
    await expect(
      addAgentToolOverride(unusedDb, agentId, { name: "github-mcp" }, { type: "board", agentId }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("removeAgentToolOverride rejects a non-board actor", async () => {
    await expect(
      removeAgentToolOverride(unusedDb, agentId, "github-mcp", { type: "agent", agentId: "peer-agent" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("addAgentRightOverride rejects a non-board actor", async () => {
    await expect(
      addAgentRightOverride(
        unusedDb,
        agentId,
        { permissionKey: "tasks:assign", scope: null },
        { type: "agent", agentId: "peer-agent" },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("addAgentRightOverride rejects self-targeting", async () => {
    await expect(
      addAgentRightOverride(
        unusedDb,
        agentId,
        { permissionKey: "tasks:assign", scope: null },
        { type: "board", agentId },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("removeAgentRightOverride rejects a non-board actor", async () => {
    await expect(
      removeAgentRightOverride(unusedDb, agentId, "tasks:assign", { type: "agent", agentId: "peer-agent" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

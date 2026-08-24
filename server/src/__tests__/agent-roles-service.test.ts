// DUR-148: getAgentRoleState's tool/right override diffing logic used to live
// inline in the GET /agents/:id/role route handler (routes/agent-roles.ts).
// It moved to services/agent-roles.ts so the new role/tools and role/rights
// override routes can compute the same "what came from the job vs. what's
// been added/removed on top of it" diff after mutating state, without
// duplicating the diffing code. These tests exercise the moved logic
// directly against a stubbed `db`, no real database needed.
import { describe, expect, it, vi } from "vitest";
import { getAgentRoleState } from "../services/agent-roles.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const roleId = "33333333-3333-4333-8333-333333333333";

const baseAgent = {
  id: agentId,
  companyId,
  roleId: null as string | null,
  adapterConfig: { mcpServers: [] as Array<Record<string, unknown>> },
  roleAppliedMcpServerNames: [] as string[],
  roleAppliedPermissionKeys: [] as string[],
};

const baseRole = {
  id: roleId,
  companyId,
  name: "Tech developer",
  description: "Writes code",
  defaultGrants: [{ permissionKey: "tasks:assign", scope: null }],
};

describe("getAgentRoleState", () => {
  it("returns the full shape with empty arrays for an agent with no role assigned", async () => {
    const mockSelect = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ ...baseAgent }]) }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      });
    const fakeDb = { select: mockSelect } as any;

    const state = await getAgentRoleState(fakeDb, agentId);

    expect(state).toEqual({
      job: null,
      assignedAt: null,
      tools: { fromJob: [], added: [], removed: [] },
      rights: { fromJob: [], added: [], removed: [] },
    });
  });

  it("computes tool/right override diffs for an agent with an assigned role", async () => {
    const agentWithRole = {
      ...baseAgent,
      roleId,
      adapterConfig: { mcpServers: [{ name: "github-mcp" }, { name: "extra-tool" }] },
      roleAppliedMcpServerNames: ["github-mcp", "removed-tool"],
      roleAppliedPermissionKeys: ["tasks:assign", "revoked:key"],
    };
    const mockSelect = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([agentWithRole]) }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([baseRole]) }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { permissionKey: "tasks:assign", scope: null },
            { permissionKey: "extra:grant", scope: null },
          ]),
        }),
      });
    const fakeDb = { select: mockSelect } as any;

    const state = await getAgentRoleState(fakeDb, agentId);

    expect(state.job).toEqual({ id: roleId, name: "Tech developer", description: "Writes code" });
    expect(state.tools).toEqual({
      fromJob: ["github-mcp"],
      added: ["extra-tool"],
      removed: ["removed-tool"],
    });
    expect(state.rights.fromJob).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
    expect(state.rights.added).toEqual([{ permissionKey: "extra:grant", scope: null }]);
    expect(state.rights.removed).toEqual([{ permissionKey: "revoked:key", scope: null }]);
  });

  it("throws notFound for a missing agent", async () => {
    const mockSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    });
    const fakeDb = { select: mockSelect } as any;

    await expect(getAgentRoleState(fakeDb, agentId)).rejects.toMatchObject({ status: 404 });
  });
});

import { describe, expect, it } from "vitest";
import { companyRoleFromAccess } from "./useCompanyRole";

/** DUR-3997: owner and admin may change connections; operator and viewer see status only. */
describe("companyRoleFromAccess", () => {
  const CO = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";

  it("lets the owner and an admin manage connections", () => {
    for (const role of ["owner", "admin"] as const) {
      const info = companyRoleFromAccess(CO, {
        isInstanceAdmin: false,
        memberships: [{ companyId: CO, membershipRole: role, status: "active" }],
      });
      expect(info).toEqual({ role, isInstanceAdmin: false, canManageConnections: true });
    }
  });

  it("shows operators and viewers status only", () => {
    for (const role of ["operator", "viewer"] as const) {
      const info = companyRoleFromAccess(CO, {
        isInstanceAdmin: false,
        memberships: [{ companyId: CO, membershipRole: role, status: "active" }],
      });
      expect(info.canManageConnections).toBe(false);
      expect(info.role).toBe(role);
    }
  });

  it("ignores an inactive membership and a membership in another company", () => {
    expect(
      companyRoleFromAccess(CO, {
        isInstanceAdmin: false,
        memberships: [
          { companyId: CO, membershipRole: "owner", status: "suspended" },
          { companyId: OTHER, membershipRole: "owner", status: "active" },
        ],
      }),
    ).toEqual({ role: null, isInstanceAdmin: false, canManageConnections: false });
  });

  it("lets an instance admin manage connections in any company", () => {
    expect(companyRoleFromAccess(CO, { isInstanceAdmin: true, memberships: [] }).canManageConnections).toBe(true);
  });
});

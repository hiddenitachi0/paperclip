import { describe, expect, it, vi } from "vitest";
import { assertBoardOrgAccess, assertCompanyAccess, assertLightAllowed, hasBoardOrgAccess } from "../routes/authz.js";
import type { accessService } from "../services/access.js";

function makeReq(input: {
  method?: string;
  actor: Express.Request["actor"];
}) {
  return {
    method: input.method ?? "GET",
    actor: input.actor,
  } as Express.Request;
}

describe("assertCompanyAccess", () => {
  it("allows viewer memberships to read", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects viewer memberships for writes", () => {
    const req = makeReq({
      method: "PATCH",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [
          { companyId: "company-1", membershipRole: "viewer", status: "active" },
        ],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("Viewer access is read-only");
  });

  it("rejects writes when membership details are present but omit the target company", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have active company access");
  });

  it("allows legacy board actors that only provide company ids", () => {
    const req = makeReq({
      method: "POST",
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("rejects signed-in instance admins without explicit company access", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
        memberships: [],
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).toThrow("User does not have access to this company");
  });

  it("allows local trusted board access without explicit membership", () => {
    const req = makeReq({
      method: "GET",
      actor: {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      },
    });

    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });
});

describe("assertBoardOrgAccess", () => {
  it("allows signed-in board users with active company access", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("allows instance admins without company memberships", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: true,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(true);
    expect(() => assertBoardOrgAccess(req)).not.toThrow();
  });

  it("rejects signed-in users without company access or instance admin rights", () => {
    const req = makeReq({
      actor: {
        type: "board",
        userId: "outsider-1",
        source: "session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      },
    });

    expect(hasBoardOrgAccess(req)).toBe(false);
    expect(() => assertBoardOrgAccess(req)).toThrow("Company membership or instance admin access required");
  });
});

// DUR-4094: the "Employee (light)" role's central default-deny gate. Every
// one of assertCompanyAccess's ~300 existing call sites must refuse this
// role unless the specific route opted in with assertLightAllowed, GET
// included -- this is the one test that proves that refusal actually fires
// from the shared gate rather than depending on every route to remember it.
describe("assertCompanyAccess — Employee (light) default deny (DUR-4094)", () => {
  function employeeReq(method: string) {
    return {
      method,
      actor: {
        type: "board",
        userId: "employee-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "employee", status: "active" }],
      },
    } as Express.Request;
  }

  it("refuses a GET for an employee role that no route has opted in", () => {
    const req = employeeReq("GET");
    expect(() => assertCompanyAccess(req, "company-1")).toThrow(
      "Employee (light) accounts can only use features an admin has turned on for them.",
    );
  });

  it("allows the GET once the route has set req.lightRouteOptIn", () => {
    const req = employeeReq("GET");
    req.lightRouteOptIn = true;
    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("still leaves non-employee roles (e.g. viewer) unaffected", () => {
    const req = {
      method: "GET",
      actor: {
        type: "board",
        userId: "viewer-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
      },
    } as Express.Request;
    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });
});

describe("assertLightAllowed (DUR-4094)", () => {
  function fakeAccess(hasPermission: boolean): ReturnType<typeof accessService> {
    return { hasPermission: vi.fn().mockResolvedValue(hasPermission) } as unknown as ReturnType<typeof accessService>;
  }

  function employeeReq() {
    return {
      method: "GET",
      actor: {
        type: "board",
        userId: "employee-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "employee", status: "active" }],
      },
    } as Express.Request;
  }

  it("throws for an employee with no matching feature grant", async () => {
    const req = employeeReq();
    await expect(assertLightAllowed(req, "company-1", "feature:pa_chat", fakeAccess(false))).rejects.toThrow(
      /has not been given "feature:pa_chat" access/,
    );
  });

  it("allows an employee once the admin has granted the named feature", async () => {
    const req = employeeReq();
    await expect(assertLightAllowed(req, "company-1", "feature:pa_chat", fakeAccess(true))).resolves.not.toThrow();
    expect(req.lightRouteOptIn).toBe(true);
  });

  it("is a no-op for a non-employee role, regardless of grants", async () => {
    const req = {
      method: "GET",
      actor: {
        type: "board",
        userId: "admin-1",
        source: "session",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      },
    } as Express.Request;
    await expect(assertLightAllowed(req, "company-1", "feature:pa_chat", fakeAccess(false))).resolves.not.toThrow();
    expect(req.lightRouteOptIn).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";

const mockRole = vi.hoisted(() => vi.fn());
vi.mock("./useCompanyRole", () => ({ useCompanyRole: mockRole }));

import { useCanUseContracts } from "./useCanUseContracts";

const base = { role: null, isInstanceAdmin: false, localBoard: false, canManageConnections: false, isLoading: false };

describe("useCanUseContracts", () => {
  it("is closed while the role loads, and for read-only and unknown members", () => {
    mockRole.mockReturnValue({ ...base, isLoading: true });
    expect(useCanUseContracts("c")).toBe(false);
    mockRole.mockReturnValue({ ...base, role: "viewer" });
    expect(useCanUseContracts("c")).toBe(false);
    mockRole.mockReturnValue(base);
    expect(useCanUseContracts("c")).toBe(false);
  });

  it("is open to owners, admins, operators, instance admins and the local board", () => {
    for (const role of ["owner", "admin", "operator"] as const) {
      mockRole.mockReturnValue({ ...base, role });
      expect(useCanUseContracts("c")).toBe(true);
    }
    mockRole.mockReturnValue({ ...base, isInstanceAdmin: true });
    expect(useCanUseContracts("c")).toBe(true);
    mockRole.mockReturnValue({ ...base, localBoard: true, isInstanceAdmin: true });
    expect(useCanUseContracts("c")).toBe(true);
  });
});

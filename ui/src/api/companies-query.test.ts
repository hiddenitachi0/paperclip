import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("./companies", () => ({
  companiesApi: mockCompaniesApi,
}));

const { companiesListQueryOptions } = await import("./companies-query");

describe("companiesListQueryOptions (DUR-2408)", () => {
  it("resolves 403 (unauthenticated board request) as unauthorized rather than throwing", async () => {
    mockCompaniesApi.list.mockRejectedValueOnce(new ApiError("Forbidden", 403, null));

    await expect(companiesListQueryOptions.queryFn()).resolves.toEqual({
      companies: [],
      unauthorized: true,
    });
  });

  it("resolves 401 as unauthorized", async () => {
    mockCompaniesApi.list.mockRejectedValueOnce(new ApiError("Unauthorized", 401, null));

    await expect(companiesListQueryOptions.queryFn()).resolves.toEqual({
      companies: [],
      unauthorized: true,
    });
  });

  it("rethrows non-auth errors instead of masking them as unauthorized", async () => {
    mockCompaniesApi.list.mockRejectedValueOnce(new ApiError("Internal Server Error", 500, null));

    await expect(companiesListQueryOptions.queryFn()).rejects.toThrow("Internal Server Error");
  });
});

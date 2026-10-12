import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { environmentsApi } from "./environments";

describe("environmentsApi company context", () => {
  beforeEach(() => {
    mockApi.patch.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockResolvedValue({});
    mockApi.post.mockResolvedValue({});
  });

  it("sends the company context when saving plain env vars on an environment", async () => {
    const body = {
      name: "Local",
      driver: "local" as const,
      config: {},
      envVars: { OLLAMA_CONTEXT_LENGTH: { type: "plain", value: "32768" } },
    };

    await environmentsApi.update("env-1", body, "company-1");

    expect(mockApi.patch).toHaveBeenCalledWith("/environments/env-1?companyId=company-1", body);
  });

  it("sends the company context when probing a saved environment", async () => {
    await environmentsApi.probe("env-1", "company-1");

    expect(mockApi.post).toHaveBeenCalledWith("/environments/env-1/probe?companyId=company-1", {});
  });

  it("omits the query when no company is selected", async () => {
    await environmentsApi.update("env-1", { name: "Local" });

    expect(mockApi.patch).toHaveBeenCalledWith("/environments/env-1", { name: "Local" });
  });
});

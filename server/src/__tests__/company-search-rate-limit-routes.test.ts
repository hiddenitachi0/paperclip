import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import { withFakeCompanyScopeReserve } from "./helpers/fake-scoped-db.js";
import type { CompanySearchQuery, CompanySearchResponse } from "@paperclipai/shared";

const companyId = "11111111-1111-4111-8111-111111111111";

function createSearchResponse(query: CompanySearchQuery): CompanySearchResponse {
  return {
    query: query.q,
    normalizedQuery: query.q.trim().toLowerCase(),
    scope: query.scope,
    limit: query.limit,
    offset: query.offset,
    results: [],
    countsByType: { issue: 0, artifact: 0, agent: 0, project: 0, contract: 0 },
    hasMore: false,
  };
}

describe("company search route rate limiting", () => {
  it("rejects repeated same-actor search calls before invoking search", async () => {
    const search = vi.fn(async (_companyId: string, query: CompanySearchQuery) => createSearchResponse(query));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        companyIds: [companyId],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(withFakeCompanyScopeReserve({}) as never, {} as never, {
      searchService: { search },
      searchRateLimiter: createCompanySearchRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    }));

    await request(app).get(`/api/companies/${companyId}/search?q=wizard`).expect(200);
    const limited = await request(app).get(`/api/companies/${companyId}/search?q=wizard`).expect(429);

    expect(search).toHaveBeenCalledTimes(1);
    expect(limited.body).toMatchObject({
      error: "Search rate limit exceeded",
      retryAfterSeconds: 60,
    });
    expect(limited.headers["retry-after"]).toBe("60");
  });

  // DUR-4853: contracts are confidential, so search only includes them for a
  // caller who may use the contract register (the viewer / agent / other-company
  // cases of that rule are covered in contract-files-routes.test.ts).
  it("asks for contract results on behalf of a board caller who may use contracts", async () => {
    const search = vi.fn(async (_companyId: string, query: CompanySearchQuery, _options?: unknown) => createSearchResponse(query));
    function appFor(actor: Express.Request["actor"]) {
      const app = express();
      app.use((req, _res, next) => {
        req.actor = actor;
        next();
      });
      app.use("/api", issueRoutes(withFakeCompanyScopeReserve({}) as never, {} as never, {
        searchService: { search },
        searchRateLimiter: createCompanySearchRateLimiter({ maxRequests: 100, windowMs: 60_000, now: () => 1_000 }),
      }));
      return app;
    }

    await request(appFor({ type: "board", userId: "user-1", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }))
      .get(`/api/companies/${companyId}/search?q=notice`)
      .expect(200);
    expect(search).toHaveBeenLastCalledWith(companyId, expect.anything(), { includeContracts: true });
  });
});

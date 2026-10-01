import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { positionsJobsPathAliasMiddleware } from "./positions-jobs-aliases.js";

function run(url: string): string {
  const req = { url } as Request;
  const next = vi.fn();
  positionsJobsPathAliasMiddleware()(req, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return req.url;
}

describe("positionsJobsPathAliasMiddleware", () => {
  it("rewrites the company-scoped positions collection onto agent-roles", () => {
    expect(run("/companies/abc-123/positions")).toBe("/companies/abc-123/agent-roles");
  });

  it("rewrites a bare /positions/:id onto /agent-roles/:id", () => {
    expect(run("/positions/role-1")).toBe("/agent-roles/role-1");
  });

  it("preserves query strings", () => {
    expect(run("/companies/abc-123/positions?status=active")).toBe("/companies/abc-123/agent-roles?status=active");
  });

  it("does not touch the real Jobs feature's own routes", () => {
    expect(run("/companies/abc-123/jobs")).toBe("/companies/abc-123/jobs");
    expect(run("/jobs/job-1/run")).toBe("/jobs/job-1/run");
    expect(run("/import/jobs/job-1")).toBe("/import/jobs/job-1");
    expect(run("/plugins/plugin-1/jobs")).toBe("/plugins/plugin-1/jobs");
  });

  it("does not touch unrelated paths", () => {
    expect(run("/companies/abc-123/routines")).toBe("/companies/abc-123/routines");
    expect(run("/agent-roles/role-1")).toBe("/agent-roles/role-1");
  });
});

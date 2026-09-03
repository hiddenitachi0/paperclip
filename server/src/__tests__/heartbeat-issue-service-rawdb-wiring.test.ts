import { describe, expect, it, vi } from "vitest";
import { createRequestScopedDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";

// DUR-381 regression (found by the signoff-policy e2e suite on PR #218):
// routes/issues.ts and routes/agents.ts construct heartbeatService() from the
// request-scoped proxy and pass `rawDb` alongside it. heartbeatService's own
// internal issueService instance is what executeRun() uses for the
// auto-checkout of a woken issue -- a fire-and-forget continuation that runs
// AFTER the originating request's company scope has been released. On that
// path issueService.checkout() -> clearExecutionRunIfTerminal() calls
// withCompanyScope(rawDb, ...), which with no active scope falls through to
// `rawDb.transaction()`. If heartbeatService forgot to thread `rawDb` into
// issueService, that `rawDb` is really the proxy, whose `.transaction` trap
// hard-throws "db.transaction() is not supported through the request-scoped
// proxy" -- every auto-checkout heartbeat run failed at setup.
//
// This pins the wiring; the behavioral guard is tests/e2e/signoff-policy.spec.ts
// ("changes requested: reviewer bounces back to executor"), which drives a
// real wake -> executeRun -> checkout through the HTTP server.
const { issueServiceSpy } = vi.hoisted(() => ({ issueServiceSpy: vi.fn() }));

vi.mock("../services/issues.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issues.js")>();
  return {
    ...actual,
    issueService: (db: Db, options?: Parameters<typeof actual.issueService>[1]) => {
      issueServiceSpy(db, options);
      return actual.issueService(db, options);
    },
  };
});

describe("heartbeatService issueService rawDb wiring (DUR-381)", () => {
  it("threads the raw pooled db into its internal issueService, not the request-scoped proxy", { timeout: 30_000 }, () => {
    const rawDb = {} as Db;
    const scopedDb = createRequestScopedDb(rawDb);

    heartbeatService(scopedDb, { rawDb });

    // Identity checks only: the proxy throws on any property access made
    // outside a scope (including the introspection vitest's toBe/toEqual do
    // while formatting), so never hand it to a matcher directly.
    const call = issueServiceSpy.mock.calls.find(([db]) => db === scopedDb);
    expect(call, "heartbeatService should construct issueService from the db it was given").toBeDefined();
    const options = call?.[1] as { rawDb?: Db } | undefined;
    expect(
      Object.is(options?.rawDb, rawDb),
      "issueService must receive the raw pooled db as options.rawDb (got the proxy or nothing instead)",
    ).toBe(true);
  });
});

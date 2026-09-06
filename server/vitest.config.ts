import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded-Postgres teardown is legitimately slow, not deadlocked. Almost
    // every suite here ends in `afterAll(() => tempDb.cleanup())`, and that
    // cleanup calls `instance.stop()`, which SIGINTs the postmaster. SIGINT is
    // a Postgres *fast shutdown*: it runs a shutdown checkpoint that fsyncs
    // every dirty buffer the suite wrote. On a write-heavy file that is 5-10s
    // even on an idle NVMe, and more on a contended CI runner, so vitest's
    // 10s default hookTimeout made teardown a coin flip while every assertion
    // passed. The suites themselves already budget 20-60s for the same I/O;
    // give their teardown a matching budget.
    hookTimeout: 60_000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});

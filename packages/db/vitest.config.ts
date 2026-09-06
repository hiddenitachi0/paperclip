import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // See server/vitest.config.ts: `EmbeddedPostgresTestDatabase.cleanup()`
    // SIGINTs the postmaster, which makes Postgres run a shutdown checkpoint
    // that fsyncs everything the suite wrote. Here it is worse than in server/,
    // because these `afterEach` hooks pop a whole stack of instances and tear
    // them down one after another inside a single hook, while the default
    // (parallel) pool has several clusters checkpointing at once. Vitest's 10s
    // default hookTimeout is far too small for that; the tests themselves
    // already carry explicit 20-60s timeouts for the same work.
    hookTimeout: 60_000,
  },
});

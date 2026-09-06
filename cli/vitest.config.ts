import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Same embedded-Postgres teardown cost as server/ and packages/db: these
    // suites end in `afterAll(() => tempDb.cleanup())`, which SIGINTs the
    // postmaster and blocks on a Postgres shutdown checkpoint. Raised here too
    // so the third consumer of the helper does not inherit the same latent
    // 10s-default flake.
    hookTimeout: 60_000,
  },
});

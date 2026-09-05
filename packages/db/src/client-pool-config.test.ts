import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";

// DUR-3918: createDb() now reads PAPERCLIP_DB_POOL_MAX (falling back to a
// raised default of 20, up from postgres.js's own default of 10) so the
// app's single request-serving pool can be sized to the per-request
// reserved-connection pattern runInCompanyScope/runInCompanyScopeBypass rely
// on (see the comment above createDb in client.ts). These assertions only
// inspect the constructed client's `.options.max` -- postgres() never
// connects until a query is issued, so no real Postgres server is needed.

const ORIGINAL_POOL_MAX = process.env.PAPERCLIP_DB_POOL_MAX;

afterEach(() => {
  if (ORIGINAL_POOL_MAX === undefined) delete process.env.PAPERCLIP_DB_POOL_MAX;
  else process.env.PAPERCLIP_DB_POOL_MAX = ORIGINAL_POOL_MAX;
});

describe("createDb pool sizing", () => {
  it("defaults to 20 connections when PAPERCLIP_DB_POOL_MAX is unset", () => {
    delete process.env.PAPERCLIP_DB_POOL_MAX;
    const db = createDb("postgres://user:pass@127.0.0.1:1/db");
    try {
      expect(db.$client.options.max).toBe(20);
    } finally {
      void db.$client.end({ timeout: 0 });
    }
  });

  it("honors PAPERCLIP_DB_POOL_MAX when set to a valid positive integer", () => {
    process.env.PAPERCLIP_DB_POOL_MAX = "45";
    const db = createDb("postgres://user:pass@127.0.0.1:1/db");
    try {
      expect(db.$client.options.max).toBe(45);
    } finally {
      void db.$client.end({ timeout: 0 });
    }
  });

  it("falls back to the default for a non-numeric or non-positive override", () => {
    for (const invalid of ["not-a-number", "0", "-5", ""]) {
      process.env.PAPERCLIP_DB_POOL_MAX = invalid;
      const db = createDb("postgres://user:pass@127.0.0.1:1/db");
      try {
        expect(db.$client.options.max).toBe(20);
      } finally {
        void db.$client.end({ timeout: 0 });
      }
    }
  });
});

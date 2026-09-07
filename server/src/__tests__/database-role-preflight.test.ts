import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  classifyRolePosture,
  evaluateDatabaseRolePreflight,
  inspectDatabaseRole,
  resolveDatabaseRolePreflightMode,
  runDatabaseRolePreflight,
  type DatabaseRoleFacts,
} from "../services/database-role-preflight.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function facts(overrides: Partial<DatabaseRoleFacts> & { role: string }): DatabaseRoleFacts {
  const base = { isSuperuser: false, ownsTables: false, inScoped: false, inBypass: false };
  const merged = { ...base, ...overrides };
  return { ...merged, posture: overrides.posture ?? classifyRolePosture(merged) };
}

describe("database role preflight (DUR-3945): pure classification and wording", () => {
  it("classifies each credential shape the runbook talks about", () => {
    expect(classifyRolePosture({ isSuperuser: true, ownsTables: true, inScoped: false, inBypass: false })).toBe("superuser");
    expect(classifyRolePosture({ isSuperuser: false, ownsTables: true, inScoped: false, inBypass: false })).toBe("table-owner");
    expect(classifyRolePosture({ isSuperuser: false, ownsTables: false, inScoped: false, inBypass: true })).toBe("bypass-login");
    expect(classifyRolePosture({ isSuperuser: false, ownsTables: false, inScoped: true, inBypass: false })).toBe("scoped-login");
    expect(classifyRolePosture({ isSuperuser: false, ownsTables: false, inScoped: false, inBypass: false })).toBe("no-access");
    expect(classifyRolePosture({ isSuperuser: false, ownsTables: false, inScoped: true, inBypass: true })).toBe("invariant-violated");
  });

  it("today's shape (superuser everywhere) is workable, RLS does not bind, and the note says so plainly", () => {
    const su = facts({ role: "paperclip", isSuperuser: true, ownsTables: true });
    const result = evaluateDatabaseRolePreflight({ app: su, bypass: su, sharedCredential: true });
    expect(result.problems).toEqual([]);
    expect(result.rlsBindsAppPool).toBe(false);
    expect(result.notes.join("\n")).toMatch(/superuser/);
    expect(result.notes.join("\n")).toMatch(/runbook/);
  });

  it("the intermediate step (app + bypass on the bypass login) is workable and explains that isolation is not binding yet", () => {
    const bypass = facts({ role: "paperclip_app_bypass_login", inBypass: true });
    const result = evaluateDatabaseRolePreflight({ app: bypass, bypass, sharedCredential: true });
    expect(result.problems).toEqual([]);
    expect(result.rlsBindsAppPool).toBe(false);
    expect(result.notes.join("\n")).toMatch(/no longer the table owner/);
  });

  it("the final step (scoped app pool, separate bypass pool) is workable and RLS binds", () => {
    const result = evaluateDatabaseRolePreflight({
      app: facts({ role: "paperclip_app_scoped_login", inScoped: true }),
      bypass: facts({ role: "paperclip_app_bypass_login", inBypass: true }),
      sharedCredential: false,
    });
    expect(result.problems).toEqual([]);
    expect(result.rlsBindsAppPool).toBe(true);
    expect(result.notes.join("\n")).toMatch(/final cutover positions/);
  });

  it("a scoped app pool with NO separate bypass pool is a problem: the scheduler and sign-in flows would fail", () => {
    const scoped = facts({ role: "paperclip_app_scoped_login", inScoped: true });
    const result = evaluateDatabaseRolePreflight({ app: scoped, bypass: scoped, sharedCredential: true });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/DATABASE_BYPASS_URL is not set/);
    expect(result.problems[0]).toMatch(/background scheduler/);
  });

  it("an app role with neither membership is called out as 'the instance will look empty'", () => {
    const stranger = facts({ role: "stranger" });
    const result = evaluateDatabaseRolePreflight({
      app: stranger,
      bypass: facts({ role: "paperclip_app_bypass_login", inBypass: true }),
      sharedCredential: false,
    });
    expect(result.problems.join("\n")).toMatch(/zero rows/);
    expect(result.problems.join("\n")).toMatch(/look empty/);
  });

  it("a role holding both memberships is flagged with the exact REVOKE to run", () => {
    const both = facts({ role: "oops", inScoped: true, inBypass: true });
    const result = evaluateDatabaseRolePreflight({
      app: both,
      bypass: facts({ role: "paperclip_app_bypass_login", inBypass: true }),
      sharedCredential: false,
    });
    expect(result.problems.join("\n")).toMatch(/REVOKE paperclip_app_bypass FROM oops/);
  });

  it("preflight mode is 'warn' unless PAPERCLIP_DB_ROLE_PREFLIGHT=strict", () => {
    expect(resolveDatabaseRolePreflightMode({})).toBe("warn");
    expect(resolveDatabaseRolePreflightMode({ PAPERCLIP_DB_ROLE_PREFLIGHT: "true" })).toBe("warn");
    expect(resolveDatabaseRolePreflightMode({ PAPERCLIP_DB_ROLE_PREFLIGHT: " STRICT " })).toBe("strict");
  });
});

describeEmbeddedPostgres("database role preflight (DUR-3945): against the real roles from migration 0160", () => {
  let db!: ReturnType<typeof createDb>;
  let connectionString!: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const password = "preflight-test-only";

  function asUser(user: string) {
    const url = new URL(connectionString);
    url.username = user;
    url.password = password;
    return url.toString();
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-role-preflight-");
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    await db.execute(sql.raw(`ALTER ROLE paperclip_app_scoped_login PASSWORD '${password}'`));
    await db.execute(sql.raw(`ALTER ROLE paperclip_app_bypass_login PASSWORD '${password}'`));
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reads the owner/superuser test credential as 'superuser' with memberships reported as not-applicable", async () => {
    const facts = await inspectDatabaseRole(db);
    expect(facts.posture).toBe("superuser");
    expect(facts.inScoped).toBe(false);
    expect(facts.inBypass).toBe(false);
  });

  it("reads the two login roles as scoped-login and bypass-login, and the final layout as workable", async () => {
    const scopedPool = createDb(asUser("paperclip_app_scoped_login"), "paperclip-preflight-test");
    const bypassPool = createDb(asUser("paperclip_app_bypass_login"), "paperclip-preflight-test");
    try {
      const scoped = await inspectDatabaseRole(scopedPool);
      expect(scoped).toMatchObject({ role: "paperclip_app_scoped_login", posture: "scoped-login", ownsTables: false });
      const bypass = await inspectDatabaseRole(bypassPool);
      expect(bypass).toMatchObject({ role: "paperclip_app_bypass_login", posture: "bypass-login", ownsTables: false });

      const result = await runDatabaseRolePreflight({ appDb: scopedPool, bypassDb: bypassPool, sharedCredential: false });
      expect(result.problems).toEqual([]);
      expect(result.rlsBindsAppPool).toBe(true);

      // The intermediate runbook step: both URLs on the bypass login.
      const intermediate = await runDatabaseRolePreflight({ appDb: bypassPool, bypassDb: bypassPool, sharedCredential: true });
      expect(intermediate.problems).toEqual([]);
      expect(intermediate.rlsBindsAppPool).toBe(false);

      // The mistake the preflight exists for: scoped app pool, no bypass pool.
      const broken = await runDatabaseRolePreflight({ appDb: scopedPool, bypassDb: scopedPool, sharedCredential: true });
      expect(broken.problems).toHaveLength(1);
    } finally {
      await scopedPool.$client.end({ timeout: 5 });
      await bypassPool.$client.end({ timeout: 5 });
    }
  });
});

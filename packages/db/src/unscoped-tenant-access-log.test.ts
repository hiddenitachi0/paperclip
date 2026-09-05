import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTenantTableRegex,
  createUnscopedTenantAccessDebugHook,
  isUnscopedTenantAccessLoggingEnabled,
} from "./unscoped-tenant-access-log.js";

describe("isUnscopedTenantAccessLoggingEnabled", () => {
  it("is off for unset/empty/unrecognized values", () => {
    expect(isUnscopedTenantAccessLoggingEnabled({})).toBe(false);
    expect(isUnscopedTenantAccessLoggingEnabled({ PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS: "" })).toBe(false);
    expect(isUnscopedTenantAccessLoggingEnabled({ PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS: "nope" })).toBe(false);
  });

  it("is on for '1' or 'true' (case/whitespace insensitive)", () => {
    expect(isUnscopedTenantAccessLoggingEnabled({ PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS: "1" })).toBe(true);
    expect(isUnscopedTenantAccessLoggingEnabled({ PAPERCLIP_LOG_UNSCOPED_TENANT_ACCESS: " TRUE " })).toBe(true);
  });
});

describe("buildTenantTableRegex", () => {
  it("returns null for an empty table list", () => {
    expect(buildTenantTableRegex([])).toBeNull();
  });

  it("matches a whole-word table name and captures it", () => {
    const re = buildTenantTableRegex(["issues", "issue_comments"]);
    expect(re).not.toBeNull();
    expect('select * from "issues" where id = $1'.match(re!)?.[1]).toBe("issues");
    expect("select * from issue_comments".match(re!)?.[1]).toBe("issue_comments");
  });

  it("does not match a table name that only appears as a substring of another identifier", () => {
    const re = buildTenantTableRegex(["issues"]);
    expect("select * from sub_issues_archive".match(re!)).toBeNull();
  });
});

describe("createUnscopedTenantAccessDebugHook", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function hookWithTables(applicationName: string, tables: string[]) {
    const hook = createUnscopedTenantAccessDebugHook(applicationName);
    hook.setTenantTables(tables);
    return hook;
  }

  it("logs a raw query against a tenant table with no claim set", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, 'select * from "issues" where id = $1', ["some-id"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('tenant table "issues"');
  });

  it("does not log once the withCompanyScope local claim is set on that connection", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, "SELECT set_config('app.current_company_id', $1, true)", ["company-a"]);
    hook.debug(1, 'select * from "issues"', []);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not log once the runInCompanyScope session claim is set on that connection", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, "select set_config('app.current_company_id', $1, false)", ["company-a"]);
    hook.debug(1, 'select * from "issues"', []);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resumes logging after the local claim's transaction commits", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, "BEGIN", []);
    hook.debug(1, "SELECT set_config('app.current_company_id', $1, true)", ["company-a"]);
    hook.debug(1, 'select * from "issues"', []);
    hook.debug(1, "COMMIT", []);
    hook.debug(1, 'select * from "issues"', []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("resumes logging after the session claim is explicitly reset", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, "select set_config('app.current_company_id', $1, false)", ["company-a"]);
    hook.debug(1, "RESET app.current_company_id", []);
    hook.debug(1, 'select * from "issues"', []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not log queries following a cross_company_access_log audit insert on the same connection", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, 'insert into "cross_company_access_log" ("reason") values ($1)', ["board review"]);
    hook.debug(1, 'select * from "issues"', []);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("re-arms bypass acknowledgment on the next transaction (BEGIN)", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, 'insert into "cross_company_access_log" ("reason") values ($1)', ["board review"]);
    hook.debug(1, "BEGIN", []);
    hook.debug(1, 'select * from "issues"', []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("tracks claim state independently per connection id", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, "select set_config('app.current_company_id', $1, false)", ["company-a"]);
    hook.debug(2, 'select * from "issues"', []);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("logs only once per (applicationName, table) pair for the process lifetime", () => {
    const hook = hookWithTables("paperclip-app", ["issues"]);
    hook.debug(1, 'select * from "issues"', []);
    hook.debug(2, 'select * from "issues"', []);
    hook.debug(3, 'select * from "issues" where id = $1', ["x"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing before setTenantTables has been called", () => {
    const hook = createUnscopedTenantAccessDebugHook("paperclip-app");
    hook.debug(1, 'select * from "issues"', []);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

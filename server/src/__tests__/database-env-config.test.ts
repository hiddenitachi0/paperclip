import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inspectMigrations } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { claudeEnvHasOwnCredential } from "../services/claude-credential-source.js";
import {
  SERVER_ANTHROPIC_API_KEY_ENV,
  captureServerOnlyAnthropicApiKey,
  readAnthropicApiKey,
  resetCapturedServerAnthropicApiKeyForTests,
  readNonBlankEnv,
  readNonBlankEnvValue,
  resolveMigrationConnectionString,
} from "../env-values.js";

// DUR-3945: production now takes DATABASE_URL / DATABASE_BYPASS_URL /
// DATABASE_MIGRATION_URL / ANTHROPIC_API_KEY from a hand-edited docker/.env.
// A blank line like `DATABASE_MIGRATION_URL=` must mean "not set" everywhere;
// before this change startup used "" as the migration address.

const REAL_URL = "postgres://paperclip:paperclip@db:5432/paperclip";
const OWNER_URL = "postgres://owner:not-real@db:5432/paperclip";
const BYPASS_URL = "postgres://bypass:not-real@db:5432/paperclip";

const TOUCHED_KEYS = [
  "PAPERCLIP_CONFIG",
  "DATABASE_URL",
  "DATABASE_BYPASS_URL",
  "DATABASE_MIGRATION_URL",
  "ANTHROPIC_API_KEY",
  "PAPERCLIP_SERVER_ANTHROPIC_API_KEY",
] as const;
const savedEnv = new Map<string, string | undefined>(TOUCHED_KEYS.map((key) => [key, process.env[key]]));
function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("readNonBlankEnvValue", () => {
  it("treats unset, empty and whitespace-only as unset, and trims real values", () => {
    expect(readNonBlankEnvValue(undefined)).toBeUndefined();
    expect(readNonBlankEnvValue(null)).toBeUndefined();
    expect(readNonBlankEnvValue("")).toBeUndefined();
    expect(readNonBlankEnvValue("   \t\n")).toBeUndefined();
    expect(readNonBlankEnvValue(`  ${OWNER_URL}\n`)).toBe(OWNER_URL);
  });

  it("reads a named variable from a given environment", () => {
    expect(readNonBlankEnv("X", {})).toBeUndefined();
    expect(readNonBlankEnv("X", { X: " " })).toBeUndefined();
    expect(readNonBlankEnv("X", { X: "value" })).toBe("value");
  });
});

describe("readAnthropicApiKey", () => {
  it("covers unset, empty, whitespace and a real value", () => {
    expect(readAnthropicApiKey({})).toBeUndefined();
    expect(readAnthropicApiKey({ ANTHROPIC_API_KEY: "" })).toBeUndefined();
    expect(readAnthropicApiKey({ ANTHROPIC_API_KEY: "   " })).toBeUndefined();
    expect(readAnthropicApiKey({ ANTHROPIC_API_KEY: " sk-test " })).toBe("sk-test");
  });
});

describe("server-only Anthropic key (agents must never inherit it)", () => {
  const KEY = "sk-ant-server-only-test-key";

  afterEach(() => {
    resetCapturedServerAnthropicApiKeyForTests();
    restoreEnv();
  });

  it("reads the server-only name first, then plain ANTHROPIC_API_KEY", () => {
    expect(readAnthropicApiKey({ [SERVER_ANTHROPIC_API_KEY_ENV]: ` ${KEY} ` })).toBe(KEY);
    expect(readAnthropicApiKey({ [SERVER_ANTHROPIC_API_KEY_ENV]: KEY, ANTHROPIC_API_KEY: "sk-other" })).toBe(KEY);
    expect(readAnthropicApiKey({ [SERVER_ANTHROPIC_API_KEY_ENV]: "  ", ANTHROPIC_API_KEY: "sk-other" })).toBe("sk-other");
  });

  it("capture takes the key out of process.env but the server can still read it", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env[SERVER_ANTHROPIC_API_KEY_ENV] = KEY;
    captureServerOnlyAnthropicApiKey();
    expect(process.env[SERVER_ANTHROPIC_API_KEY_ENV]).toBeUndefined();
    expect(readAnthropicApiKey()).toBe(KEY);
    // A second call with nothing set keeps the captured key.
    captureServerOnlyAnthropicApiKey();
    expect(readAnthropicApiKey()).toBe(KEY);
  });

  it("after capture, an agent built from { ...process.env } has no key and no API-key credential", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env[SERVER_ANTHROPIC_API_KEY_ENV] = KEY;
    captureServerOnlyAnthropicApiKey();

    // claude_local builds its run env as { ...process.env, ...env }: the
    // worst case, since it bypasses runChildProcess's own inherited-env strip.
    const agentEnv = Object.fromEntries(
      Object.entries({ ...process.env }).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    expect(claudeEnvHasOwnCredential(agentEnv)).toBe(false);

    const result = await runChildProcess(
      "dur3945-anthropic-key-leak-test",
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { cwd: process.cwd(), env: agentEnv, timeoutSec: 20, graceSec: 2, onLog: async () => {} },
    );
    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv[SERVER_ANTHROPIC_API_KEY_ENV]).toBeUndefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.stdout).not.toContain(KEY);
  });
});

describe("resolveMigrationConnectionString", () => {
  it("falls back to DATABASE_URL when the migration login is unset or blank", () => {
    expect(resolveMigrationConnectionString(undefined, REAL_URL)).toBe(REAL_URL);
    expect(resolveMigrationConnectionString("", REAL_URL)).toBe(REAL_URL);
    expect(resolveMigrationConnectionString("  ", REAL_URL)).toBe(REAL_URL);
  });

  it("uses the migration login when it is a real value", () => {
    expect(resolveMigrationConnectionString(OWNER_URL, REAL_URL)).toBe(OWNER_URL);
  });
});

describe("loadConfig database logins (DUR-3945)", () => {
  let tmpDir: string;
  let loadConfig: typeof import("../config.js").loadConfig;
  let resolveDatabaseRoleUrls: typeof import("../config.js").resolveDatabaseRoleUrls;

  beforeAll(async () => {
    // Point config at an empty directory so no developer config/.env leaks in.
    tmpDir = mkdtempSync(path.join(tmpdir(), "paperclip-db-env-config-"));
    process.env.PAPERCLIP_CONFIG = path.join(tmpDir, "config.json");
    ({ loadConfig, resolveDatabaseRoleUrls } = await import("../config.js"));
  });

  afterEach(() => {
    restoreEnv();
    process.env.PAPERCLIP_CONFIG = path.join(tmpDir, "config.json");
  });

  afterAll(() => {
    restoreEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadWith(values: Partial<Record<(typeof TOUCHED_KEYS)[number], string | undefined>>) {
    for (const key of ["DATABASE_URL", "DATABASE_BYPASS_URL", "DATABASE_MIGRATION_URL"] as const) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return loadConfig();
  }

  it("unset: migration login is undefined and bypass follows DATABASE_URL (today's behaviour)", () => {
    const config = loadWith({ DATABASE_URL: REAL_URL });
    expect(config.databaseUrl).toBe(REAL_URL);
    expect(config.databaseMigrationUrl).toBeUndefined();
    expect(config.databaseBypassUrl).toBe(REAL_URL);
  });

  it("empty: treated exactly like unset", () => {
    const config = loadWith({ DATABASE_URL: REAL_URL, DATABASE_MIGRATION_URL: "", DATABASE_BYPASS_URL: "" });
    expect(config.databaseMigrationUrl).toBeUndefined();
    expect(config.databaseBypassUrl).toBe(REAL_URL);
  });

  it("whitespace-only: treated exactly like unset", () => {
    const config = loadWith({ DATABASE_URL: REAL_URL, DATABASE_MIGRATION_URL: "  \t", DATABASE_BYPASS_URL: " " });
    expect(config.databaseMigrationUrl).toBeUndefined();
    expect(config.databaseBypassUrl).toBe(REAL_URL);
  });

  it("real values: used, trimmed", () => {
    const config = loadWith({
      DATABASE_URL: REAL_URL,
      DATABASE_MIGRATION_URL: ` ${OWNER_URL} `,
      DATABASE_BYPASS_URL: `${BYPASS_URL}\n`,
    });
    expect(config.databaseMigrationUrl).toBe(OWNER_URL);
    expect(config.databaseBypassUrl).toBe(BYPASS_URL);
  });

  it("resolveDatabaseRoleUrls is the same rule loadConfig uses", () => {
    expect(resolveDatabaseRoleUrls({ DATABASE_MIGRATION_URL: "" }, REAL_URL)).toEqual({
      databaseBypassUrl: REAL_URL,
      databaseMigrationUrl: undefined,
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres migration-address test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("startup migration address against a real database (DUR-3945)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("db-env-config-");
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("a blank DATABASE_MIGRATION_URL still lets startup inspect migrations on DATABASE_URL", async () => {
    const migrationUrl = resolveMigrationConnectionString("", tempDb!.connectionString);
    expect(migrationUrl).toBe(tempDb!.connectionString);
    const state = await inspectMigrations(migrationUrl);
    expect(state.status).toBe("upToDate");
  });

  it("the old rule (\"\" ?? DATABASE_URL) would have handed startup an empty address", () => {
    // Documents the trap this change removes: nullish-coalescing keeps "".
    const blank: string | undefined = "";
    expect(blank ?? tempDb!.connectionString).toBe("");
  });
});

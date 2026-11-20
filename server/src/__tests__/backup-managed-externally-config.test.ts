import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// DUR-5176: PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY turns the server's own
// scheduled backup off (a separate backup container owns the dumps). Unset it
// must change nothing for installs without that container.

const KEYS = ["PAPERCLIP_CONFIG", "PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY", "PAPERCLIP_DB_BACKUP_ENABLED"] as const;
// Deployment settings a developer's or container's environment may carry; the
// default config must load the same everywhere.
const NEUTRAL_KEYS = [
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_DEPLOYMENT_EXPOSURE",
  "PAPERCLIP_BIND",
  "PAPERCLIP_BIND_HOST",
  "PAPERCLIP_LISTEN_HOST",
  "HOST",
] as const;
const saved = new Map<string, string | undefined>([...KEYS, ...NEUTRAL_KEYS].map((k) => [k, process.env[k]]));
function restoreEnv() {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("loadConfig databaseBackupManagedExternally (DUR-5176)", () => {
  let tmpDir: string;
  let loadConfig: typeof import("../config.js").loadConfig;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paperclip-backup-managed-config-"));
    process.env.PAPERCLIP_CONFIG = path.join(tmpDir, "config.json");
    ({ loadConfig } = await import("../config.js"));
  });
  afterEach(() => {
    restoreEnv();
    process.env.PAPERCLIP_CONFIG = path.join(tmpDir, "config.json");
  });
  afterAll(() => {
    restoreEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function load(values: Partial<Record<(typeof KEYS)[number], string>>) {
    for (const key of NEUTRAL_KEYS) delete process.env[key];
    delete process.env.PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY;
    delete process.env.PAPERCLIP_DB_BACKUP_ENABLED;
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return loadConfig();
  }

  it("unset: the server keeps scheduling its own backups, exactly as before", () => {
    const config = load({});
    expect(config.databaseBackupManagedExternally).toBe(false);
    expect(config.databaseBackupEnabled).toBe(true);
  });

  it("an explicit 'false' or any value other than 'true' leaves the server's backups on", () => {
    for (const value of ["false", "0", "yes", ""]) {
      const config = load({ PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY: value });
      expect(config.databaseBackupManagedExternally).toBe(false);
      expect(config.databaseBackupEnabled).toBe(true);
    }
  });

  it("'true' switches the scheduled backup off", () => {
    const config = load({ PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY: "true" });
    expect(config.databaseBackupManagedExternally).toBe(true);
    expect(config.databaseBackupEnabled).toBe(false);
  });

  it("'true' wins over PAPERCLIP_DB_BACKUP_ENABLED=true (the server must never dump into its own volume)", () => {
    const config = load({
      PAPERCLIP_DB_BACKUP_MANAGED_EXTERNALLY: "true",
      PAPERCLIP_DB_BACKUP_ENABLED: "true",
    });
    expect(config.databaseBackupEnabled).toBe(false);
  });

  it("PAPERCLIP_DB_BACKUP_ENABLED=false still works on its own", () => {
    const config = load({ PAPERCLIP_DB_BACKUP_ENABLED: "false" });
    expect(config.databaseBackupManagedExternally).toBe(false);
    expect(config.databaseBackupEnabled).toBe(false);
  });
});

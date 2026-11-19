import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { selectBackupsToDelete, type BackupRetentionPolicy } from "./backup-lib.js";

// DUR-5176: the backup sidecar (scripts/backup-sidecar.sh) re-implements the
// retention tiers of selectBackupsToDelete in POSIX shell, because the
// postgres:17-alpine container it runs in has no Node. These tests pin the two
// to the same answers and exercise the dump/prune/failure behaviour with a fake
// pg_dump, so a change to either side that makes them disagree fails here.

const SCRIPT = path.resolve(__dirname, "../../../scripts/backup-sidecar.sh");
const HOUR = 3600;
const DAY = 24 * HOUR;

beforeAll(() => {
  // Retention buckets are calendar days/weeks/months; the script works in UTC.
  process.env.TZ = "UTC";
});

function selectInShell(entries: Array<{ name: string; mtime: number }>, now: number, r: BackupRetentionPolicy) {
  const res = spawnSync("sh", [SCRIPT, "select-expired"], {
    input: entries.map((e) => `${e.mtime} ${e.name}`).join("\n") + "\n",
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      BACKUP_NOW: String(now),
      BACKUP_DAILY_DAYS: String(r.dailyDays),
      BACKUP_WEEKLY_WEEKS: String(r.weeklyWeeks),
      BACKUP_MONTHLY_MONTHS: String(r.monthlyMonths),
    },
  });
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.split("\n").filter(Boolean).sort();
}

function selectInTs(entries: Array<{ name: string; mtime: number }>, now: number, r: BackupRetentionPolicy) {
  return selectBackupsToDelete(
    entries.map((e) => ({ name: e.name, mtimeMs: e.mtime * 1000 })),
    r,
    now * 1000,
  )
    .map((e) => e.name)
    .sort();
}

// Small deterministic generator so failures reproduce.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("backup-sidecar.sh retention matches selectBackupsToDelete", () => {
  const nows = [
    Date.UTC(2026, 5, 15, 12, 0, 0) / 1000, // mid-month
    Date.UTC(2026, 2, 31, 23, 59, 59) / 1000, // 31 March: monthly cut-off overflows February
    Date.UTC(2026, 0, 1, 0, 0, 0) / 1000, // new year (ISO week belongs to the previous year)
    Date.UTC(2024, 1, 29, 6, 30, 0) / 1000, // leap day
  ];
  const policies: BackupRetentionPolicy[] = [
    { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    { dailyDays: 3, weeklyWeeks: 1, monthlyMonths: 6 },
    { dailyDays: 14, weeklyWeeks: 2, monthlyMonths: 3 },
  ];

  for (const now of nows) {
    for (const policy of policies) {
      it(`agrees at ${new Date(now * 1000).toISOString()} with ${JSON.stringify(policy)}`, () => {
        const rand = lcg(now ^ policy.dailyDays);
        const entries: Array<{ name: string; mtime: number }> = [];
        // Hourly for the last 3 days, then a few per day further back, plus a few in the future.
        for (let h = 0; h < 72; h++) entries.push({ name: `paperclip-h${h}.sql.gz`, mtime: now - h * HOUR - Math.floor(rand() * 600) });
        for (let i = 0; i < 400; i++) {
          entries.push({ name: `paperclip-r${i}.sql.gz`, mtime: now - Math.floor(rand() * 220 * DAY) });
        }
        entries.push({ name: "paperclip-future.sql.gz", mtime: now + 5 * HOUR });
        const shell = selectInShell(entries, now, policy);
        const ts = selectInTs(entries, now, policy);
        expect(shell).toEqual(ts);
        // And the selection is not trivially empty or total.
        expect(shell.length).toBeGreaterThan(0);
        expect(shell.length).toBeLessThan(entries.length);
      });
    }
  }
});

describe("backup-sidecar.sh dump run", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function setup(fakePgDump: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-sidecar-"));
    dirs.push(root);
    const bin = path.join(root, "bin");
    const out = path.join(root, "out");
    fs.mkdirSync(bin);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(bin, "pg_dump"), `#!/bin/sh\n${fakePgDump}\n`, { mode: 0o755 });
    const secrets = path.join(root, "backup.env");
    fs.writeFileSync(secrets, "# comment\nPGUSER=paperclip_backup\nPGPASSWORD=s3cret-canary-value\nIGNORED=1\n", { mode: 0o400 });
    const run = (mode: string, extra: Record<string, string> = {}) =>
      spawnSync("sh", [SCRIPT, mode], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          BACKUP_DIR: out,
          BACKUP_SECRETS_FILE: secrets,
          BACKUP_HEALTH_MARKER: path.join(root, "last-ok"),
          BACKUP_RETENTION_FROM_DB: "0",
          ...extra,
        },
      });
    return { root, out, secrets, run };
  }

  it("writes a dump with the server's file name and format, then prunes", () => {
    const { out, run } = setup(
      // Record the login pg_dump was given; print a plain-format dump.
      `echo "$PGPASSWORD" > "$FAKE_SEEN_PW" 2>/dev/null || true\necho "-- dump for $*"\necho "SELECT 1;"`,
    );
    // Old dumps: one per hour for ~60h plus ancient ones; the ancient ones must go.
    const now = Math.floor(Date.now() / 1000);
    const old = ["paperclip-20200101-000000.sql.gz", "paperclip-20200102-000000.sql.gz"];
    for (const name of old) {
      const f = path.join(out, name);
      fs.writeFileSync(f, "x");
      const t = new Date((now - 400 * DAY) * 1000);
      fs.utimesSync(f, t, t);
    }
    fs.writeFileSync(path.join(out, "unrelated.txt"), "keep me");

    const res = run("once", { FAKE_SEEN_PW: path.join(out, "..", "pw-seen") });
    expect(res.status, res.stderr).toBe(0);

    const files = fs.readdirSync(out).sort();
    const dumps = files.filter((f) => /^paperclip-\d{8}-\d{6}\.sql\.gz$/.test(f) && !old.includes(f));
    expect(dumps).toHaveLength(1);
    expect(files).toContain("unrelated.txt");
    for (const name of old) expect(files).not.toContain(name);
    expect(files.filter((f) => f.startsWith("."))).toEqual([]); // no temp files left
    // Same bytes the server would write: gzip of pg_dump's plain output.
    const sql = spawnSync("gzip", ["-dc", path.join(out, dumps[0]!)], { encoding: "utf8" }).stdout;
    expect(sql).toContain("SELECT 1;");
    expect(sql).toContain("--format=plain --clean --if-exists --no-owner --no-privileges");
    expect(sql).toContain("--username=paperclip_backup");
    expect(sql).not.toContain("s3cret-canary-value"); // never on the command line
    // The password reached pg_dump's environment, and nothing the script printed.
    expect(fs.readFileSync(path.join(out, "..", "pw-seen"), "utf8").trim()).toBe("s3cret-canary-value");
    expect(res.stdout + res.stderr).not.toContain("s3cret-canary-value");
  });

  it("exits non-zero and keeps nothing when pg_dump fails mid-stream", () => {
    const { out, run } = setup(`echo "partial output"\necho "pg_dump: error: connection lost" >&2\nexit 1`);
    const res = run("once");
    expect(res.status).not.toBe(0);
    expect(fs.readdirSync(out)).toEqual([]);
    expect(res.stderr).toContain("dump failed");
    expect(res.stderr).not.toContain("s3cret-canary-value");
  });

  it("never prunes when the dump fails", () => {
    const { out, run } = setup(`exit 1`);
    const f = path.join(out, "paperclip-20200101-000000.sql.gz");
    fs.writeFileSync(f, "x");
    const t = new Date(Date.now() - 800 * DAY * 1000);
    fs.utimesSync(f, t, t);
    expect(run("once").status).not.toBe(0);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("refuses to run without a database login", () => {
    const { run, secrets } = setup(`echo ok`);
    fs.rmSync(secrets);
    fs.writeFileSync(secrets, "PGUSER=only-user\n");
    const res = run("once");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("PGPASSWORD is not set");
  });

  it("takes the retention from Instance Settings when the database returns it, else keeps the service settings", () => {
    const { out, root, run } = setup(`echo "SELECT 1;"`);
    const now = Math.floor(Date.now() / 1000);
    // A 45-day-old dump is only kept inside a window of more than one month.
    const fortyFiveDays = path.join(out, "paperclip-20200101-000000.sql.gz");
    fs.writeFileSync(fortyFiveDays, "x");
    const t = new Date((now - 45 * DAY) * 1000);
    fs.utimesSync(fortyFiveDays, t, t);
    // A psql that answers like the database: daily 14, weekly 2, monthly 6.
    const fakeBin = path.join(root, "bin");
    fs.writeFileSync(path.join(fakeBin, "psql"), "#!/bin/sh\necho '14 2 6'\n", { mode: 0o755 });
    const res = run("once", { BACKUP_RETENTION_FROM_DB: "1" });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain("retention from Instance Settings: daily 14 day(s), weekly 2 week(s), monthly 6 month(s)");
    expect(fs.existsSync(fortyFiveDays)).toBe(true); // 6-month window keeps it

    // (Two runs inside one second would collide on the file name: refuse, never overwrite.)
    for (const f of fs.readdirSync(out)) if (f !== path.basename(fortyFiveDays)) fs.rmSync(path.join(out, f));
    // An unreadable answer falls back to the service settings (1 month: 45 days is outside).
    fs.writeFileSync(path.join(fakeBin, "psql"), "#!/bin/sh\necho 'garbage'\n", { mode: 0o755 });
    const res2 = run("once", { BACKUP_RETENTION_FROM_DB: "1" });
    expect(res2.status, res2.stderr).toBe(0);
    expect(res2.stderr).toContain("retention from the service settings");
    expect(fs.existsSync(fortyFiveDays)).toBe(false);
  });

  it("healthcheck passes only after a recent successful dump", () => {
    const { run } = setup(`echo "SELECT 1;"`);
    expect(run("healthcheck").status).not.toBe(0);
    expect(run("once").status).toBe(0);
    expect(run("healthcheck").status).toBe(0);
  });
});

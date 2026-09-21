/**
 * DUR-3994 Stage 1: the hourly backup must not put the database password on
 * pg_dump's command line (or in its environment), where every process in the
 * container -- agents included -- can read it. And it must still write the
 * SAME backups as before: same pg_dump engine, same file name pattern, same
 * folder, gzip'd plain SQL restorable with psql exactly as today (the
 * offsite copy to the Storage Box depends on all of that).
 *
 * Runs against a real embedded Postgres with a random password, through a
 * real pg_dump wrapped by a tiny spy that records its own command line and
 * environment. Skipped when no pg_dump at least as new as the test server is
 * available (set PAPERCLIP_TEST_PG_DUMP / PAPERCLIP_TEST_PSQL to point at
 * one); the Docker acceptance run (scripts/agent-isolation-acceptance.sh)
 * covers the production image end to end either way.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDatabaseBackup, runDatabaseRestore, splitPostgresPassword } from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

function toolMajor(bin: string): number | null {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = /(\d+)(?:\.\d+)?/.exec(out);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const PG_DUMP = process.env.PAPERCLIP_TEST_PG_DUMP || "pg_dump";
const PSQL = process.env.PAPERCLIP_TEST_PSQL || "psql";
const pgDumpMajor = toolMajor(PG_DUMP);
const psqlMajor = toolMajor(PSQL);
const embeddedSupport = await getEmbeddedPostgresTestSupport();

describe("splitPostgresPassword", () => {
  it("takes the password out of the address and keeps everything else", () => {
    expect(splitPostgresPassword("postgres://paperclip:p%40ss%2Fw@db:5432/paperclip")).toEqual({
      connectionString: "postgres://paperclip@db:5432/paperclip",
      password: "p@ss/w",
    });
    expect(splitPostgresPassword("postgresql://u:pw@h/d?sslmode=require&password=other")).toEqual({
      connectionString: "postgresql://u@h/d?sslmode=require",
      password: "pw",
    });
    expect(splitPostgresPassword("postgres://u@h/d?password=q")).toEqual({
      connectionString: "postgres://u@h/d",
      password: "q",
    });
  });

  it("leaves addresses without a password, and non-URL forms, exactly as they were", () => {
    expect(splitPostgresPassword("postgres://u@h:5432/d")).toEqual({
      connectionString: "postgres://u@h:5432/d",
      password: null,
    });
    expect(splitPostgresPassword("host=db dbname=x")).toEqual({ connectionString: "host=db dbname=x", password: null });
  });
});

describe.skipIf(!embeddedSupport.supported || pgDumpMajor === null || psqlMajor === null)(
  "pg_dump backup keeps the password off its command line (DUR-3994)",
  () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    let serverMajor = 0;
    let passwordUrl = "";
    let password = "";
    let workDir = "";

    beforeAll(async () => {
      const db = await startEmbeddedPostgresTestDatabase("paperclip-dur3994-pgdump-");
      cleanups.push(db.cleanup);
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dur3994-pgdump-work-"));
      cleanups.push(() => fs.rmSync(workDir, { recursive: true, force: true }));

      // A fresh random password, so a leak is recognisable and nothing real is used.
      password = `DUR3994CANARY${randomBytes(12).toString("hex")}`;
      const admin = postgres(db.connectionString, { max: 1, onnotice: () => {} });
      try {
        serverMajor = Math.floor(Number((await admin`SHOW server_version_num`)[0]!.server_version_num) / 10000);
        await admin.unsafe(`ALTER ROLE paperclip PASSWORD '${password}'`);
      } finally {
        await admin.end();
      }
      const url = new URL(db.connectionString);
      url.password = password;
      passwordUrl = url.toString();

      const source = postgres(passwordUrl, { max: 1, onnotice: () => {} });
      try {
        // Things only pg_dump carries (the fallback engine does not): a
        // function, a trigger and a row-level-security policy.
        await source.unsafe(`
          CREATE TABLE public.dur3994_items (id serial PRIMARY KEY, title text NOT NULL, touched int NOT NULL DEFAULT 0);
          CREATE FUNCTION public.dur3994_touch() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.touched := NEW.touched + 1; RETURN NEW; END $$;
          CREATE TRIGGER dur3994_touch BEFORE UPDATE ON public.dur3994_items
            FOR EACH ROW EXECUTE FUNCTION public.dur3994_touch();
          ALTER TABLE public.dur3994_items ENABLE ROW LEVEL SECURITY;
          CREATE POLICY dur3994_all ON public.dur3994_items USING (true);
          INSERT INTO public.dur3994_items (title) VALUES ('one'), ('two'), ('three');
        `);
      } finally {
        await source.end();
      }
    }, 120_000);

    afterAll(async () => {
      while (cleanups.length > 0) await cleanups.pop()?.();
    });

    it("hands pg_dump the password without its command line or environment, and the backup restores the same way", async (ctx) => {
      if (pgDumpMajor! < serverMajor || psqlMajor! < serverMajor) {
        ctx.skip();
        return;
      }
      // A spy in front of the real pg_dump: records its own command line and
      // environment (as any process in the container could read them).
      const spyDir = path.join(workDir, "spy");
      fs.mkdirSync(spyDir);
      const spy = path.join(spyDir, "pg_dump");
      fs.writeFileSync(
        spy,
        [
          "#!/bin/sh",
          `cat /proc/$$/cmdline > '${spyDir}/cmdline'`,
          `cat /proc/$$/environ > '${spyDir}/environ'`,
          `exec '${PG_DUMP.replaceAll("'", "'\\''")}' "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const backupDir = path.join(workDir, "backups");
      const previousBin = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = spy;
      let result;
      try {
        result = await runDatabaseBackup({
          connectionString: passwordUrl,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip",
          backupEngine: "auto",
        });
      } finally {
        if (previousBin === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousBin;
      }

      // Same engine, same name, same folder, gzip as before.
      expect(result.engine).toBe("pg_dump");
      expect(result.pgDumpFailureReason).toBeUndefined();
      expect(path.dirname(result.backupFile)).toBe(path.resolve(backupDir));
      expect(path.basename(result.backupFile)).toMatch(/^paperclip-\d{8}-\d{6}\.sql\.gz$/);
      const head = fs.readFileSync(result.backupFile).subarray(0, 2);
      expect([head[0], head[1]]).toEqual([0x1f, 0x8b]);

      // The password was not visible to other processes.
      const cmdline = fs.readFileSync(path.join(spyDir, "cmdline"), "latin1");
      const environ = fs.readFileSync(path.join(spyDir, "environ"), "latin1");
      expect(cmdline).toContain("--dbname=");
      expect(cmdline.includes(password)).toBe(false);
      expect(environ.includes(password)).toBe(false);

      // Restores exactly as before (psql over the gunzipped plain SQL), with
      // the function, trigger, policy and rows intact.
      const adminUrl = new URL(passwordUrl);
      adminUrl.pathname = "/postgres";
      await ensurePostgresDatabase(adminUrl.toString(), "dur3994_restore");
      const restoreUrl = new URL(passwordUrl);
      restoreUrl.pathname = "/dur3994_restore";
      const previousPsql = process.env.PAPERCLIP_PSQL_PATH;
      process.env.PAPERCLIP_PSQL_PATH = PSQL;
      try {
        await runDatabaseRestore({ connectionString: restoreUrl.toString(), backupFile: result.backupFile });
      } finally {
        if (previousPsql === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
        else process.env.PAPERCLIP_PSQL_PATH = previousPsql;
      }
      const restored = postgres(restoreUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        const rows = await restored`SELECT title FROM public.dur3994_items ORDER BY id`;
        expect(rows.map((r) => r.title)).toEqual(["one", "two", "three"]);
        const triggers = await restored`SELECT tgname FROM pg_trigger WHERE tgname = 'dur3994_touch'`;
        expect(triggers).toHaveLength(1);
        const policies = await restored`SELECT policyname FROM pg_policies WHERE policyname = 'dur3994_all'`;
        expect(policies).toHaveLength(1);
        await restored`UPDATE public.dur3994_items SET title = title WHERE id = 1`;
        const touched = await restored`SELECT touched FROM public.dur3994_items WHERE id = 1`;
        expect(touched[0]!.touched).toBe(1);
      } finally {
        await restored.end();
      }
    }, 120_000);
  },
);

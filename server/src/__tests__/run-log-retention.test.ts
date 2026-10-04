import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneRunLogs } from "../services/run-log-retention.js";

const DAY = 24 * 60 * 60 * 1000;

describe("pruneRunLogs (DUR-4498)", () => {
  let tmp: string;
  let base: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runlogs-"));
    base = path.join(tmp, "run-logs");
    await fs.mkdir(base);
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function write(rel: string, ageDays: number) {
    const p = path.join(base, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "x");
    const t = new Date(Date.now() - ageDays * DAY);
    await fs.utimes(p, t, t);
    return p;
  }
  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  it("deletes old logs, keeps recent ones, removes emptied dirs", async () => {
    const old = await write("co/agent/old.ndjson", 40);
    const fresh = await write("co/agent/new.ndjson", 5);
    const oldOnly = await write("co/gone/old.ndjson", 31);
    const res = await pruneRunLogs(base, 30);
    expect(await exists(old)).toBe(false);
    expect(await exists(oldOnly)).toBe(false);
    expect(await exists(path.dirname(oldOnly))).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(res.filesDeleted).toBe(2);
    expect(await exists(base)).toBe(true);
  });

  it("is idempotent and tolerates empty or missing dirs", async () => {
    await write("a/old.ndjson", 99);
    await pruneRunLogs(base, 30);
    const again = await pruneRunLogs(base, 30);
    expect(again.filesDeleted).toBe(0);
    expect(await pruneRunLogs(path.join(tmp, "missing"), 30)).toEqual({
      filesDeleted: 0,
      bytesFreed: 0,
      dirsRemoved: 0,
    });
  });

  it("never follows or deletes through symlinks outside the base dir", async () => {
    const outside = path.join(tmp, "outside");
    await fs.mkdir(outside);
    const victim = path.join(outside, "victim.txt");
    await fs.writeFile(victim, "x");
    const t = new Date(Date.now() - 99 * DAY);
    await fs.utimes(victim, t, t);
    await fs.symlink(outside, path.join(base, "linkdir"));
    await fs.symlink(victim, path.join(base, "linkfile"));
    await pruneRunLogs(base, 30);
    expect(await exists(victim)).toBe(true);
  });

  it("disabled when retentionDays <= 0", async () => {
    const old = await write("old.ndjson", 99);
    await pruneRunLogs(base, 0);
    expect(await exists(old)).toBe(true);
  });
});

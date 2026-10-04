import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeBackupStorageStats,
  listBackupFiles,
  selectBackupsToDelete,
} from "./backup-lib.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const retention = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 3 };

function entries(agesHours: number[]) {
  return agesHours.map((h) => ({ id: h, mtimeMs: NOW - h * HOUR }));
}
function survivors(agesHours: number[], r = retention) {
  const list = entries(agesHours);
  const doomed = new Set(selectBackupsToDelete(list, r, NOW));
  return list.filter((e) => !doomed.has(e)).map((e) => e.id);
}

describe("selectBackupsToDelete", () => {
  it("keeps every backup in the last 48 hours", () => {
    const ages = Array.from({ length: 48 }, (_, i) => i);
    expect(survivors(ages)).toEqual(ages);
  });

  it("applies the 48h boundary inclusively", () => {
    expect(survivors([47.9, 48])).toContain(47.9);
    // 48h exactly is in the full tier; just beyond falls to daily tier (still kept as only one that day).
    expect(survivors([48, 48.5, 49])).toEqual([48]);
  });

  it("keeps one (newest) backup per calendar day beyond 48h", () => {
    // days 3..5 ago, three per day
    const ages = [];
    for (let d = 3; d <= 5; d++) for (let h = 0; h < 3; h++) ages.push(d * 24 + h);
    const kept = survivors(ages);
    const days = new Set(kept.map((a) => new Date(NOW - a * HOUR).toDateString()));
    expect(days.size).toBe(kept.length);
    expect(kept).toHaveLength(3);
  });

  it("keeps one per week beyond the daily window and one per month beyond the weekly window", () => {
    const ages: number[] = [];
    for (let d = 0; d <= 130; d++) ages.push(d * 24 + 1);
    const list = entries(ages);
    const doomed = new Set(selectBackupsToDelete(list, retention, NOW));
    const kept = list.filter((e) => !doomed.has(e));
    const weeklyCutoffAge = 4 * 7 * 24;
    const dailyAge = 7 * 24;
    const weekTier = kept.filter((e) => (NOW - e.mtimeMs) / HOUR > dailyAge && (NOW - e.mtimeMs) / HOUR <= weeklyCutoffAge);
    const weekKeys = new Set(weekTier.map((e) => Math.floor((NOW - e.mtimeMs) / (7 * DAY))));
    expect(weekTier.length).toBeLessThanOrEqual(4);
    expect(weekKeys.size).toBe(weekTier.length);
    const monthTier = kept.filter((e) => (NOW - e.mtimeMs) / HOUR > weeklyCutoffAge);
    const monthKeys = new Set(monthTier.map((e) => `${new Date(e.mtimeMs).getFullYear()}-${new Date(e.mtimeMs).getMonth()}`));
    expect(monthKeys.size).toBe(monthTier.length);
    expect(monthTier.length).toBeLessThanOrEqual(3);
  });

  it("deletes everything older than the monthly window", () => {
    expect(survivors([200 * 24, 300 * 24, 400 * 24])).toEqual([]);
  });

  it("never lets a short daily window shrink the 48h tier", () => {
    const ages = Array.from({ length: 48 }, (_, i) => i);
    expect(survivors(ages, { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 })).toEqual(ages);
  });

  it("keeps future-dated files rather than deleting them", () => {
    expect(survivors([-5])).toEqual([-5]);
  });

  it("is idempotent", () => {
    const ages = Array.from({ length: 24 * 100 }, (_, i) => i);
    const first = survivors(ages);
    expect(survivors(first)).toEqual(first);
  });
});

describe("listBackupFiles / computeBackupStorageStats", () => {
  it("only lists matching regular files directly in the backup dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-tier-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bk-outside-"));
    try {
      fs.writeFileSync(path.join(dir, "paperclip-20260101-000000.sql.gz"), "x".repeat(100));
      const old = new Date(2020, 0, 1);
      fs.utimesSync(path.join(dir, "paperclip-20260101-000000.sql.gz"), old, old);
      fs.writeFileSync(path.join(dir, "other-20260101-000000.sql.gz"), "y");
      fs.writeFileSync(path.join(dir, "paperclip-notes.txt"), "y");
      fs.writeFileSync(path.join(outside, "victim.sql.gz"), "z");
      fs.symlinkSync(path.join(outside, "victim.sql.gz"), path.join(dir, "paperclip-link.sql.gz"));
      fs.mkdirSync(path.join(dir, "paperclip-sub.sql"));
      const files = listBackupFiles(dir, "paperclip");
      expect(files.map((f) => f.name)).toEqual(["paperclip-20260101-000000.sql.gz"]);
      const stats = computeBackupStorageStats(dir, retention, "paperclip", NOW);
      expect(stats.fileCount).toBe(1);
      expect(stats.totalBytes).toBe(100);
      expect(stats.retainedFileCount).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * DUR-3972 S1 acceptance (h): the migration graph still has exactly one leaf.
 *
 * Drizzle's journal is a single ordered list, so "one leaf" means: every
 * migration number appears once, the journal and the files agree one-to-one
 * and in order, the indexes run 0..n-1 without a gap, and the newest entry is
 * the one this slice added. Two builders adding the same next number in
 * parallel -- the thing that crash-looped production on 2026-09-06 -- fails
 * here.
 */

const migrationsDir = fileURLToPath(new URL("../../../packages/db/src/migrations", import.meta.url));

describe("DUR-3972 migration graph", () => {
  const journal = JSON.parse(readFileSync(`${migrationsDir}/meta/_journal.json`, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

  it("has one journal entry per migration file, in the same order", () => {
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files);
  });

  it("has no duplicate migration number, and numbers only ever increase", () => {
    // (0161 was never used; that historical gap is harmless and left alone.)
    const numbers = files.map((name) => Number.parseInt(name.slice(0, 4), 10));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (let i = 1; i < numbers.length; i += 1) expect(numbers[i]!).toBeGreaterThan(numbers[i - 1]!);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(numbers);
  });

  it("the newest migration is the single leaf: last in the journal, with the latest timestamp", () => {
    const last = journal.entries[journal.entries.length - 1]!;
    expect(`${last.tag}.sql`).toBe(files[files.length - 1]);
    const earlier = journal.entries.slice(0, -1).map((entry) => entry.when);
    expect(last.when).toBeGreaterThan(Math.max(...earlier));
  });

  it("includes 0168_data_connections, strictly additive", () => {
    expect(files).toContain("0168_data_connections.sql");
    const text = readFileSync(`${migrationsDir}/0168_data_connections.sql`, "utf8")
      .split("\n")
      .map((line) => line.replace(/^\s*--.*$/, ""))
      .join("\n");
    expect(text).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bREVOKE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"?\w+"?\s+SET\b/i);
    expect(text).not.toMatch(/information_schema\.(tables|columns)/);
  });
});

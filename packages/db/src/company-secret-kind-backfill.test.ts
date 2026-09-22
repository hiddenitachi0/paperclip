import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SECRET_KIND_IDS, secretKindEnvKeyPairs, secretKindForEnvKey } from "@paperclipai/shared";

// DUR-3997: migration 0171 gives existing secrets a kind from their key
// (ANTHROPIC_API_KEY -> anthropic_api_key, and so on). The pairs live in SQL,
// the taxonomy lives in packages/shared; this test keeps the two equal so a
// kind added to one side cannot silently be missing from the other, and
// checks the backfill can only ever fill an empty kind.

const MIGRATION_PATH = new URL("./migrations/0171_company_secret_kind.sql", import.meta.url);
const migrationSql = await readFile(MIGRATION_PATH, "utf8");

/** The migration with its `--` comments stripped, for checks about what it executes. */
const migrationStatements = migrationSql
  .split("\n")
  .map((line) => line.replace(/^\s*--.*$/, ""))
  .join("\n");

/** Every `WHEN 'ENV_KEY' THEN 'kind'` pair in the backfill CASE. */
function migrationPairs(): Array<[string, string]> {
  return [...migrationSql.matchAll(/WHEN\s+'([A-Z0-9_]+)'\s+THEN\s+'([a-z0-9_]+)'/g)].map((match) => [
    match[1],
    match[2],
  ]);
}

/** The env-key names listed in the WHERE ... IN (...) guard. */
function migrationGuardKeys(): string[] {
  const match = migrationSql.match(/IN\s*\(([^)]*)\)/);
  if (!match) throw new Error("Migration 0171 has no IN (...) guard on the backfill");
  return [...match[1].matchAll(/'([A-Z0-9_]+)'/g)].map((entry) => entry[1]);
}

describe("0171_company_secret_kind backfill", () => {
  it("maps exactly the env-key names the shared taxonomy knows, to the same kinds", () => {
    const fromSql = new Map(migrationPairs());
    const fromShared = new Map(secretKindEnvKeyPairs());
    expect([...fromSql.keys()].sort()).toEqual([...fromShared.keys()].sort());
    for (const [envKey, kind] of fromShared) {
      expect(fromSql.get(envKey), envKey).toBe(kind);
      expect(secretKindForEnvKey(envKey)).toBe(kind);
    }
  });

  it("only writes kinds that exist in the taxonomy", () => {
    for (const [, kind] of migrationPairs()) {
      expect(SECRET_KIND_IDS).toContain(kind);
    }
  });

  it("guards the UPDATE with the same key list as the CASE, so no row is touched needlessly", () => {
    expect(migrationGuardKeys().sort()).toEqual(migrationPairs().map(([envKey]) => envKey).sort());
  });

  it("never overwrites a kind that is already set", () => {
    expect(migrationSql).toMatch(/WHERE\s+"kind"\s+IS\s+NULL/);
  });

  it("recognises a key the Add-integration-token dialog derived from an env var", () => {
    // That dialog stores `${ENV_KEY}__${target}` lower-cased; the SQL takes
    // the part before the first "__" and upper-cases it, as the shared helper does.
    expect(secretKindForEnvKey("openai_api_key__all_agents")).toBe("openai_api_key");
    expect(secretKindForEnvKey("github_token__lead")).toBe("github_token");
    expect(secretKindForEnvKey("MY_OWN_THING")).toBe(null);
    expect(migrationSql).toContain(`upper(split_part("key", '__', 1))`);
  });

  it("is strictly additive and idempotent", () => {
    expect(migrationStatements).not.toMatch(/\b(DROP|TRUNCATE|REVOKE)\b/i);
    for (const line of migrationStatements.split("\n")) {
      if (/^\s*ALTER TABLE/.test(line)) expect(line).toContain("ADD COLUMN IF NOT EXISTS");
    }
  });
});

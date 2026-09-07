import { pgTable, uuid, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// One-click Claude sign-in: the single instance-wide Claude subscription
// token every claude_local agent falls back to when it has no token of its
// own. `tokenSealed` is local_encrypted material (never plaintext); the
// fingerprint is a sha256 of the token so the UI can tell "same token as
// before" apart from "rotated" without ever seeing the value. Instance-wide
// like instance_settings -- no company_id, outside the company RLS set.
export const instanceClaudeAuth = pgTable(
  "instance_claude_auth",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    tokenSealed: text("token_sealed").notNull(),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    source: text("source").$type<"signin" | "pasted">().notNull().default("pasted"),
    savedByUserId: text("saved_by_user_id"),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckMessage: text("last_check_message"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastAuthFailureAt: timestamp("last_auth_failure_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("instance_claude_auth_singleton_key_idx").on(table.singletonKey),
  }),
);

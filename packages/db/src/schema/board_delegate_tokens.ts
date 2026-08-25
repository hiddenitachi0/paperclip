import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

// DUR-128: a scoped, revocable credential the operator issues to a delegate
// (a bot, an assistant, a teammate) so recovery actions don't require the
// operator's own browser session. It never authenticates AS the operator —
// every action it takes is logged as performed by the delegate, under the
// granting operator's authority (see assertBoardOrDelegate in authz.ts).
export const boardDelegateTokens = pgTable(
  "board_delegate_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    // Allowlist of delegate-scope strings (see DELEGATE_SCOPES in authz.ts).
    // Never includes merge/deploy approval — those stay operator-only by
    // construction, not by scope configuration.
    scopes: jsonb("scopes").notNull().$type<string[]>().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyHashIdx: uniqueIndex("board_delegate_tokens_key_hash_idx").on(table.keyHash),
    userIdx: index("board_delegate_tokens_user_idx").on(table.userId),
  }),
);

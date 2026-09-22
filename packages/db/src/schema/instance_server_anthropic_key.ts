import { pgTable, uuid, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// DUR-3995: Paperclip's OWN Claude key — the Anthropic API key the server
// itself calls Claude with (quick answers, the request router, the quality
// check before a task is marked done, the business-data trial). Not the key
// agents use; agents never see this one.
//
// Until now the only way to set it was PAPERCLIP_SERVER_ANTHROPIC_API_KEY in
// a file on the server plus a restart, which a non-technical owner cannot do.
// `keySealed` is local_encrypted material (the same scheme company secrets
// and the instance Claude sign-in use); this table never holds the plaintext.
// `hint` is the last four characters only, so the settings page can show
// which key is in place without ever showing the key.
//
// Instance-wide like instance_settings / instance_claude_auth: no company_id,
// deliberately outside the company RLS set from migration 0149.
export const instanceServerAnthropicKey = pgTable(
  "instance_server_anthropic_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    keySealed: text("key_sealed").notNull(),
    /** Last four characters of the key, for "which key is this?" — never more. */
    hint: text("hint").notNull(),
    /** sha256 of the key, so "same key as before" and "replaced" can be told apart. */
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    savedByUserId: text("saved_by_user_id"),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    lastTestAt: timestamp("last_test_at", { withTimezone: true }),
    lastTestOk: boolean("last_test_ok"),
    lastTestMessage: text("last_test_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("instance_server_anthropic_key_singleton_key_idx").on(table.singletonKey),
  }),
);

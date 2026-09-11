import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-3977: a machine credential belonging to one company, for server-to-server
 * calls into Paperclip (today: Nordstrand's dashboard calling the Lane A
 * transform endpoint). Deliberately shaped like `board_api_keys` and
 * `agent_api_keys` rather than inventing a new storage scheme:
 *
 *   - only the SHA-256 hash is stored (`token_hash`); the token value exists
 *     once, in the create response, and is never readable again,
 *   - `revoked_at` / `expires_at` / `last_used_at` behave exactly as they do
 *     for a board API key,
 *   - `company_id` is the company the token authenticates AS. It is not a
 *     hint the caller supplies — it is read off this row and every agent the
 *     caller then names is checked against it server-side.
 *
 * There is no `agent_id`: a token is a company credential, and which agent it
 * may drive is decided per request by that server-side check, so revoking one
 * token cannot leave a stale per-agent grant behind.
 */
export const companyServiceTokens = pgTable(
  "company_service_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdByUserId: text("created_by_user_id"),
    revokedByUserId: text("revoked_by_user_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("company_service_tokens_token_hash_idx").on(table.tokenHash),
    companyIdx: index("company_service_tokens_company_idx").on(table.companyId, table.revokedAt),
  }),
);

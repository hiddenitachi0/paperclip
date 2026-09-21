import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

// DUR-3994 Stage 2: the fingerprint of every folder of add-on code (plugins
// and external adapters) that Paperclip itself installed, recorded at install
// time. Before loading add-on code the server re-hashes the folder and refuses
// to run it if anything changed. Agents run as the same Linux user as the
// server, so this record cannot live in a file (an agent could rewrite the
// record together with the code); it lives here, where agents have no access.
//
// Instance-wide like instance_settings -- no company_id, outside the company
// RLS set. One row per code folder (code_root). One extra row, kind 'marker',
// records that the one-time first-start baseline has been taken.
export const trustedCodeFingerprints = pgTable(
  "trusted_code_fingerprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeRoot: text("code_root").notNull(),
    kind: text("kind").$type<"plugin" | "adapter" | "marker">().notNull(),
    label: text("label").notNull(),
    digest: text("digest").notNull(),
    fileHashes: jsonb("file_hashes").$type<Record<string, string>>().notNull().default({}),
    fileCount: integer("file_count").notNull().default(0),
    recordedReason: text("recorded_reason").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeRootIdx: uniqueIndex("trusted_code_fingerprints_code_root_idx").on(table.codeRoot),
  }),
);

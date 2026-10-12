import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { modelDirectoryEntries } from "./model_directory_entries.js";

/**
 * DUR-4392: the declarative "converter" list for one model directory entry --
 * a per-entry, ordered list of operations from a fixed allow-list (drop/rename
 * a request parameter, set a default, cap tools or switch tool-description
 * variant, add a system-prompt hint, strip an output wrapper like `<think>`,
 * enable text-tool-call parsing, retry once on a given error). It is data,
 * not code: packages/shared/src/model-converter-engine.ts is the only thing
 * that interprets `ops`, and it refuses anything not on the allow-list.
 *
 * One row per entry (entry_id is unique): the model setup reviewer job
 * replaces the whole `ops` array when it applies a change, after rerunning
 * the probe set and confirming the result is no worse. Undo and the
 * before/after audit trail are a separate history table the reviewer-job
 * orchestration (DUR-4558) owns; this table only holds the entry's current,
 * live converter list.
 *
 * No key, host address, or budget field is ever stored here -- this table
 * only ever reshapes a request/response around an entry that the model
 * directory already describes.
 *
 * Rollback: DROP TABLE "model_directory_converters". Safe -- nothing
 * references it, and the agent call path (lane-a) does not read it yet; a
 * rollback only loses recorded converters, not any live agent behaviour.
 */
export const modelDirectoryConverters = pgTable(
  "model_directory_converters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => modelDirectoryEntries.id, { onDelete: "cascade" }),
    // ModelConverterOp[] (packages/shared/src/model-converter-engine.ts). Validated on write by the
    // service against modelConverterOpSchema -- never trusted as-is from the row.
    ops: jsonb("ops").$type<Record<string, unknown>[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    note: text("note"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entryUq: uniqueIndex("model_directory_converters_entry_uq").on(table.entryId),
    companyIdx: index("model_directory_converters_company_idx").on(table.companyId, table.createdAt),
  }),
);

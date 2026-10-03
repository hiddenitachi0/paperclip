import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * DUR-4344: what each reaction emoji means for a company. One row per company;
 * no row means "use the built-in defaults" (see REACTION_EMOJI_DEFAULTS in
 * @paperclipai/shared), so existing companies need no backfill.
 */
export const companyReactionEmojiConfig = pgTable("company_reaction_emoji_config", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  positive: jsonb("positive").$type<string[]>().notNull(),
  negative: jsonb("negative").$type<string[]>().notNull(),
  neutral: jsonb("neutral").$type<string[]>().notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

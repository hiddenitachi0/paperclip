import { pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Catalogue v2 (8 Oct 2026): per-company settings for Settings > Models.
 * One row per company. `local_gpu_vram_gb` is the graphics memory of the
 * owner's own model PC, used to say whether a local model fits and when to
 * suggest the cloud version instead. Informational only.
 *
 * Rollback: DROP TABLE "model_directory_settings". Nothing references it.
 */
export const modelDirectorySettings = pgTable("model_directory_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  localGpuVramGb: real("local_gpu_vram_gb"),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

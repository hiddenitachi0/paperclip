import { pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Catalogue v2 (8 Oct 2026): per-company settings for Settings > Models.
 * One row per company. `local_gpu_vram_gb` is the graphics memory of the
 * computer that runs this company's local models (null = not set), used only
 * to say whether a local model fits and when to suggest the cloud version
 * instead. `local_base_url` is the address of this company's local model
 * server (Ollama or another OpenAI-compatible server) as Paperclip's server
 * reaches it; it is the default address for new local setups and the
 * ready-made local models (null = not set, and Paperclip asks for it).
 *
 * Rollback: DROP TABLE "model_directory_settings". Nothing references it.
 */
export const modelDirectorySettings = pgTable("model_directory_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  localGpuVramGb: real("local_gpu_vram_gb"),
  localBaseUrl: text("local_base_url"),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

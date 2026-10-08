/**
 * Which Fal.ai / Sogni / Higgsfield key a company's Media Studio call uses
 * on the server (the Create tab, storylines and their stills).
 *
 * A company's owner or admin can pick the company's own key for each service
 * in Media Studio's Settings tab; the plugin keeps those picks in its plugin
 * state (scope "company", key "serviceKeys"; see
 * packages/plugins/media-studio/src/company-settings.ts). A company that has
 * not picked one uses the instance's key from the plugin's instance settings
 * (set by the instance admin), exactly as before. Only secret ids are stored;
 * the caller resolves the id through its own audited secret path, which also
 * checks that the secret belongs to the company.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginState } from "@paperclipai/db";

export const MEDIA_STUDIO_SERVICE_KEYS_STATE_KEY = "serviceKeys";
export type MediaStudioKeyService = "fal" | "sogni" | "higgsfield";

const INSTANCE_FIELD: Record<MediaStudioKeyService, string> = {
  fal: "falKeySecretRef",
  sogni: "sogniKeySecretRef",
  higgsfield: "higgsfieldKeySecretRef",
};

const SECRET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The company's own pick for one service, or null. */
export async function companyMediaStudioKeyRef(db: Db, pluginId: string, companyId: string, service: MediaStudioKeyService): Promise<string | null> {
  const [row] = await db
    .select({ value: pluginState.valueJson })
    .from(pluginState)
    .where(
      and(
        eq(pluginState.pluginId, pluginId),
        eq(pluginState.scopeKind, "company"),
        eq(pluginState.scopeId, companyId),
        eq(pluginState.namespace, "default"),
        eq(pluginState.stateKey, MEDIA_STUDIO_SERVICE_KEYS_STATE_KEY),
      ),
    );
  const value = (row?.value ?? null) as Record<string, unknown> | null;
  const ref = value && typeof value === "object" ? value[service] : null;
  return typeof ref === "string" && SECRET_ID.test(ref.trim()) ? ref.trim() : null;
}

/** The secret id to use for this company: its own pick, else the instance's setting, else "". */
export async function mediaStudioKeyRef(
  db: Db,
  pluginId: string,
  companyId: string,
  service: MediaStudioKeyService,
  instanceConfig: Record<string, unknown>,
): Promise<string> {
  const own = await companyMediaStudioKeyRef(db, pluginId, companyId, service);
  if (own) return own;
  const instance = instanceConfig[INSTANCE_FIELD[service]];
  return typeof instance === "string" ? instance.trim() : "";
}

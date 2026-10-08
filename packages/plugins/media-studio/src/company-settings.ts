// Each company's own keys for the picture services (Sogni, Fal.ai,
// Higgsfield).
//
// Before this, the keys lived only in the plugin's instance settings: one
// set for the whole Paperclip instance, changeable only by the instance
// admin. Now each company's owner or admin can pick the company's own key
// for each service from the company's Secrets. A company that has not picked
// one keeps using the instance's key (set by the instance admin), so nothing
// changes for a company that already works.
//
// Storage: plugin state, scope "company", scope id = the company the host
// confirmed for the call, key "serviceKeys":
//   { sogni: <secret id> | null, fal: <secret id> | null, higgsfield: <secret id> | null }
// Only secret ids are stored. Values are looked up on the server each time a
// service is called (ctx.secrets.resolve, which only reads this company's
// secrets) and are never sent to the browser.
//
// The Paperclip server reads the same state for the Create tab and
// storylines (server/src/services/media-studio-company-keys.ts); keep the
// state key and field names in step with it.

import type { PluginContext } from "@paperclipai/plugin-sdk";

export const SERVICE_KEYS_STATE_KEY = "serviceKeys";

export const COMPANY_KEY_SERVICES = ["sogni", "fal", "higgsfield"] as const;
export type CompanyKeyService = (typeof COMPANY_KEY_SERVICES)[number];

/** The instance setting each company key stands in for. */
export const INSTANCE_KEY_FIELD: Record<CompanyKeyService, string> = {
  sogni: "sogniKeySecretRef",
  fal: "falKeySecretRef",
  higgsfield: "higgsfieldKeySecretRef",
};

export const SERVICE_LABEL: Record<CompanyKeyService, string> = { sogni: "Sogni", fal: "Fal.ai", higgsfield: "Higgsfield" };

/** What each key is for, in plain words, for the Settings tab. */
export const SERVICE_KEY_HELP: Record<CompanyKeyService, string> = {
  sogni:
    "Sogni makes pictures (and video) and runs the Edit tab's tools: upscale, remove background, select objects and more. Create the key at dashboard.sogni.ai/api-key and save it in the company's Secrets first.",
  fal:
    "Fal.ai makes pictures, video, music and speech, and runs the Edit tab's \"edit with a prompt\" and \"replace selected area\". Create the key at fal.ai (Dashboard > Keys) and save it in the company's Secrets first.",
  higgsfield:
    "Higgsfield makes pictures that keep one person through a Soul ID. Save the key in the company's Secrets as key id and key secret joined by a colon (id:secret), from Higgsfield's console (API keys).",
};

export type CompanyServiceKeys = Record<CompanyKeyService, string | null>;

const SECRET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const keysScope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: SERVICE_KEYS_STATE_KEY });

export async function loadCompanyServiceKeys(ctx: PluginContext, companyId: string): Promise<CompanyServiceKeys> {
  const raw = ((await ctx.state.get(keysScope(companyId))) ?? {}) as Record<string, unknown>;
  const out = { sogni: null, fal: null, higgsfield: null } as CompanyServiceKeys;
  for (const service of COMPANY_KEY_SERVICES) {
    const v = raw[service];
    out[service] = typeof v === "string" && SECRET_ID.test(v.trim()) ? v.trim() : null;
  }
  return out;
}

/**
 * The settings a call for this company runs with: the instance's Media
 * Studio settings, with each service key replaced by the company's own when
 * it has picked one. Every place that reads a service key goes through this.
 */
export async function companyConfig(ctx: PluginContext, companyId: string | null | undefined): Promise<Record<string, unknown>> {
  const cfg = { ...(((await ctx.config.get()) ?? {}) as Record<string, unknown>) };
  if (!companyId) return cfg;
  const own = await loadCompanyServiceKeys(ctx, companyId);
  for (const service of COMPANY_KEY_SERVICES) {
    if (own[service]) cfg[INSTANCE_KEY_FIELD[service]] = own[service];
  }
  return cfg;
}

export type KeySource = "company" | "instance" | "none";

export interface ServiceKeyView {
  service: CompanyKeyService;
  label: string;
  help: string;
  /** Where the key used for this company comes from. */
  source: KeySource;
  /** "This company's own key" / "Using the instance's key (set by the instance admin)" / "No key yet". */
  sourceText: string;
  /** The company's own pick (a secret id, never a value); null when it uses the instance's key or none. */
  companySecretId: string | null;
}

export const SOURCE_TEXT: Record<KeySource, string> = {
  company: "This company's own key",
  instance: "Using the instance's key (set by the instance admin)",
  none: "No key yet: this service cannot be used until a key is picked",
};

export async function serviceKeysView(ctx: PluginContext, companyId: string): Promise<ServiceKeyView[]> {
  const instance = ((await ctx.config.get()) ?? {}) as Record<string, unknown>;
  const own = await loadCompanyServiceKeys(ctx, companyId);
  return COMPANY_KEY_SERVICES.map((service) => {
    const instanceRef = instance[INSTANCE_KEY_FIELD[service]];
    const source: KeySource = own[service] ? "company" : typeof instanceRef === "string" && instanceRef.trim() ? "instance" : "none";
    return {
      service,
      label: SERVICE_LABEL[service],
      help: SERVICE_KEY_HELP[service],
      source,
      sourceText: SOURCE_TEXT[source],
      companySecretId: own[service],
    };
  });
}

export const ACTION_SERVICE_KEYS_GET = "serviceKeys.get";
export const ACTION_SERVICE_KEYS_SAVE = "serviceKeys.save";

interface KeysActionContext {
  companyId: string | null;
  actor: { type: string; userId?: string | null; canManageCompany?: boolean; isInstanceAdmin?: boolean };
}

/**
 * Save the company's own keys. Owner/admin only. A service left out keeps
 * its pick; null or "" clears it (back to the instance's key). A picked
 * secret must be one this company can read: it is looked up once here (the
 * value is dropped straight away), so a secret of another company is refused
 * now rather than failing later.
 */
export async function saveServiceKeys(ctx: PluginContext, params: Record<string, unknown>, context: KeysActionContext): Promise<CompanyServiceKeys> {
  if (!context.companyId) throw new Error("Open this page from inside a company.");
  if (context.actor.type !== "user" || context.actor.canManageCompany !== true) {
    throw new Error("Only the company's owner or an admin can change the company's service keys.");
  }
  const companyId = context.companyId;
  const current = await loadCompanyServiceKeys(ctx, companyId);
  const next: CompanyServiceKeys = { ...current };
  for (const service of COMPANY_KEY_SERVICES) {
    if (!(service in params)) continue;
    const v = params[service];
    if (v === null || v === undefined || v === "") {
      next[service] = null;
      continue;
    }
    if (typeof v !== "string" || !SECRET_ID.test(v.trim())) throw new Error(`Pick the ${SERVICE_LABEL[service]} key from the company's Secrets.`);
    const id = v.trim();
    if (id !== current[service]) {
      try {
        await ctx.secrets.resolve(id);
      } catch {
        throw new Error(`The ${SERVICE_LABEL[service]} key could not be read. Pick a secret from this company's Secrets.`);
      }
    }
    next[service] = id;
  }
  await ctx.state.set(keysScope(companyId), next);
  return next;
}

export function registerServiceKeyActions(ctx: PluginContext): void {
  ctx.actions.register(ACTION_SERVICE_KEYS_GET, async (_params, context) => {
    const c = context as unknown as KeysActionContext;
    if (!c.companyId) throw new Error("Open this page from inside a company.");
    return {
      keys: await serviceKeysView(ctx, c.companyId),
      canManage: c.actor.type === "user" && c.actor.canManageCompany === true,
    };
  });
  ctx.actions.register(ACTION_SERVICE_KEYS_SAVE, async (params, context) => {
    const c = context as unknown as KeysActionContext;
    await saveServiceKeys(ctx, (params ?? {}) as Record<string, unknown>, c);
    return { keys: await serviceKeysView(ctx, c.companyId!) };
  });
}

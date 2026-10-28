import type { Db } from "@paperclipai/db";
import type {
  HostServices,
  PluginMediaLora,
  PluginMediaProjectDefaults,
  PluginMediaResolvedSetup,
  PluginMediaSetup,
} from "@paperclipai/plugin-sdk";
import type { MediaLora, MediaModelSetup, MediaProjectDefaults, MediaResolvedSetup } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { mediaSetupsService } from "./media-setups.js";

/**
 * `ctx.mediaLibrary` for plugin workers (Media Studio film studio, Phase 1):
 * read-only views of the company's saved model setups, LoRA library and
 * new-project defaults. The worker has no signed-in path to the REST routes,
 * so the Create tab, the agent picture/video tools and Identities read their
 * setups through here.
 *
 * - Every method takes the company from the call (the host-client factory
 *   already holds a UI action to the company the host confirmed) and the
 *   service filters every query on it: another company's id is "not there".
 * - `approvedOnly` gives the agent view (approved setups only); the worker
 *   sets it on every path an agent drives.
 * - No write methods. The only write is the one-time starter seed, the same
 *   one the REST routes run on first use.
 * - LoRA links come without their query string on every method (`plugin`
 *   reader), as for agents: the worker hands what it reads to agent tools.
 */

function toPluginSetup(setup: MediaModelSetup): PluginMediaSetup {
  return {
    id: setup.id,
    companyId: setup.companyId,
    name: setup.name,
    description: setup.description,
    kind: setup.kind,
    provider: setup.provider,
    family: setup.family,
    mode: setup.mode,
    modelId: setup.modelId,
    editModelId: setup.editModelId,
    loras: setup.loras.map((lora) => ({ ...lora, triggerWords: [...lora.triggerWords] })),
    params: setup.params,
    contentRating: setup.contentRating,
    status: setup.status,
    tags: setup.tags,
    favorite: setup.favorite,
    notes: setup.notes,
    builtinKey: setup.builtinKey,
    billing: setup.billing,
    billingLabel: setup.billingLabel,
    triggerWords: setup.triggerWords,
    problems: setup.problems,
    updatedAt: setup.updatedAt,
  };
}

function toPluginLora(lora: MediaLora): PluginMediaLora {
  return {
    id: lora.id,
    companyId: lora.companyId,
    provider: lora.provider,
    source: lora.source,
    ref: lora.ref,
    name: lora.name,
    notes: lora.notes,
    triggerWords: lora.triggerWords,
    family: lora.family,
    compatibleModelIds: lora.compatibleModelIds,
    effectiveContentTag: lora.effectiveContentTag,
    strengthMin: lora.strengthMin,
    strengthMax: lora.strengthMax,
    strengthDefault: lora.strengthDefault,
    recommendedMin: lora.recommendedMin,
    recommendedMax: lora.recommendedMax,
  };
}

function toPluginDefaults(defaults: MediaProjectDefaults): PluginMediaProjectDefaults {
  return {
    companyId: defaults.companyId,
    defaultImageSetupId: defaults.defaultImageSetupId,
    defaultVideoSetupId: defaults.defaultVideoSetupId,
    defaultContentRating: defaults.defaultContentRating,
    defaultContinuityMode: defaults.defaultContinuityMode,
  };
}

function toPluginResolved(resolved: MediaResolvedSetup): PluginMediaResolvedSetup {
  return { ...resolved, loras: resolved.loras.map((lora) => ({ ...lora })) };
}

/** A 404 from the service ("not in this company", "not approved") is null to the worker. */
async function orNull<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

export function mediaLibraryHostService(db: Db, ensureCompanyId: (companyId?: string) => string): HostServices["mediaLibrary"] {
  const setups = mediaSetupsService(db);
  return {
    async listSetups(params) {
      const companyId = ensureCompanyId(params.companyId);
      const kind = params.kind === "image" || params.kind === "video" ? params.kind : undefined;
      return (await setups.listSetups(companyId, { agent: params.approvedOnly === true, plugin: true }, { kind })).map(toPluginSetup);
    },
    async getSetup(params) {
      const companyId = ensureCompanyId(params.companyId);
      // An archived setup is still returned by id (with its status), so a
      // worker can say so plainly; with approvedOnly only approved ones are.
      const setup = await orNull(() => setups.getSetup(companyId, String(params.setupId ?? ""), { agent: params.approvedOnly === true, plugin: true }));
      return setup ? toPluginSetup(setup) : null;
    },
    async getProjectDefaults(params) {
      const companyId = ensureCompanyId(params.companyId);
      return toPluginDefaults(await setups.getProjectDefaults(companyId));
    },
    async listLoras(params) {
      const companyId = ensureCompanyId(params.companyId);
      // The usable ones only: archived and refused LoRAs never reach a worker.
      return (await setups.listLoras(companyId, { agent: true, plugin: true })).map(toPluginLora);
    },
    async resolve(params) {
      const companyId = ensureCompanyId(params.companyId);
      const resolved = await orNull(() => setups.resolveSetup(companyId, String(params.setupId ?? ""), { agent: params.approvedOnly === true, plugin: true }));
      return resolved ? toPluginResolved(resolved) : null;
    },
  };
}

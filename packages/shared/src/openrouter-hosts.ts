import { LANE_A_PROVIDER_ROUTING_MAX_ENTRIES, type LaneAProviderRouting } from "./lane-a-models.js";

/**
 * OpenRouter hosts ("providers" in OpenRouter's API): the companies that
 * actually run a model behind OpenRouter. The same model is usually offered
 * by several hosts, and what each host supports (tool calling, pictures,
 * thinking, price, context) differs PER MODEL: a host can support tools for
 * one model and not for another. So everything here is read per model, live
 * from OpenRouter's public endpoint list, never from a fixed table.
 *
 * Company host rules (Settings > Models > OpenRouter hosts):
 * - preferred hosts: used for a new OpenRouter model setup when at least one
 *   of them runs that model with tool calling (they become its "Use" list);
 * - blocked hosts: never used. They are added to every OpenRouter setup's
 *   "Never" list when it is saved, AND again to every OpenRouter request at
 *   call time (withOpenRouterBlockedHostsForCall), so a setup saved before a
 *   host was blocked is covered too.
 *
 * Precedence, for one model setup (resolveOpenRouterHostRouting):
 * 1. A host the setup itself marks "Use" or "Never" follows that choice.
 *    An explicit "Use" even overrides the company's blocked list, on purpose,
 *    so one setup can make a deliberate exception.
 * 2. When the setup marks at least one host "Use", only those are used and
 *    the company's preferred list is ignored for that setup.
 * 3. Otherwise ("Default" everywhere): the company's preferred hosts that run
 *    this model are used, but only if at least one of them supports tool
 *    calling for it; if none does, OpenRouter chooses.
 * 4. The company's blocked hosts are always added to "Never", unless rule 1
 *    made an exception.
 */

/** A host slug as OpenRouter writes it in an endpoint tag ("deepinfra/fp8" -> "deepinfra"). */
export const OPENROUTER_HOST_SLUG_RE = /^[a-z0-9-]+$/;
/** How many hosts each company list (preferred, blocked) may hold. */
export const OPENROUTER_HOST_RULES_MAX = 30;
/** An OpenRouter model id: "author/slug", e.g. "qwen/qwen3.8-27b" or "openai/gpt-oss-20b:free". */
export const OPENROUTER_MODEL_ID_RE = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;
/** How many hosts a model setup remembers from its last check. */
export const OPENROUTER_HOSTS_SEEN_MAX = 100;

/** True for an OpenRouter model id the hosts lookup accepts ("author/slug", no "." or ".." segment). */
export function isOpenRouterModelId(model: unknown): model is string {
  if (typeof model !== "string" || !OPENROUTER_MODEL_ID_RE.test(model)) return false;
  return model.split("/").every((part) => !/^\.+$/.test(part));
}

/** What one host offers for one model (GET .../model-directory/openrouter-hosts). */
export interface OpenRouterHost {
  /** Short host name used in host lists, e.g. "deepinfra". */
  slug: string;
  /** The name OpenRouter shows, e.g. "DeepInfra". */
  name: string;
  /** How much the model was shrunk on this host, e.g. "fp8"; null = not said. */
  quantization: string | null;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  /** US dollars per million tokens sent in / written out; null = not said. */
  priceInPerM: number | null;
  priceOutPerM: number | null;
  /** The host passes tools to the model, so a quick agent can use pictures, weather, hand-overs... */
  supportsTools: boolean;
  /** The host can force one specific tool (Paperclip uses this for one corrective retry). */
  supportsToolChoice: boolean;
  supportsReasoning: boolean;
  /** The model can look at pictures (same for every host of a model). */
  supportsImages: boolean;
  /** "ok", "degraded" (OpenRouter reports trouble) or "unknown". */
  status: "ok" | "degraded" | "unknown";
  /** Share of successful requests over the last 30 minutes (0-100); null = not said. */
  uptimeLast30m: number | null;
}

export interface OpenRouterHostsResult {
  model: string;
  /** ISO time OpenRouter was asked (the list is cached for about ten minutes). */
  fetchedAt: string;
  hosts: OpenRouterHost[];
}

/** One remembered host in a setup's specs, to say what changed since the last check. */
export interface OpenRouterHostSeen {
  slug: string;
  tools: boolean;
}

export interface OpenRouterHostRules {
  preferred: readonly string[];
  blocked: readonly string[];
}

export const OPENROUTER_HOST_CHOICES = ["use", "never", "default"] as const;
export type OpenRouterHostChoice = (typeof OPENROUTER_HOST_CHOICES)[number];

/** A host's slug from an endpoint tag ("deepinfra/fp8" -> "deepinfra"), or null when it does not look like one. */
export function openRouterHostSlugFromTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const slug = tag.split("/")[0]!.trim().toLowerCase();
  return OPENROUTER_HOST_SLUG_RE.test(slug) ? slug : null;
}

/** Cleans a host list: lower case, valid slugs only, no repeats, at most `max`. */
export function cleanOpenRouterHostList(value: unknown, max = OPENROUTER_HOST_RULES_MAX): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const slug = raw.trim().toLowerCase();
    if (!OPENROUTER_HOST_SLUG_RE.test(slug) || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= max) break;
  }
  return out;
}

/** The per-host choices a saved routing stands for: "only" hosts are "use", "ignore" hosts are "never". */
export function openRouterHostChoicesFromRouting(
  routing: Pick<LaneAProviderRouting, "only" | "ignore"> | null | undefined,
): Record<string, OpenRouterHostChoice> {
  const out: Record<string, OpenRouterHostChoice> = {};
  for (const slug of routing?.ignore ?? []) out[slug] = "never";
  for (const slug of routing?.only ?? []) out[slug] = "use";
  return out;
}

/**
 * The routing a model setup is saved with, from its per-host choices and the
 * company's host rules (the precedence is documented at the top of this file).
 * `hosts` is the live host list for the model; without it the preferred list
 * cannot be checked for tool support and is not applied. Any order and
 * fallback setting already saved (`base`) is kept. Null = no host rule at all
 * (OpenRouter chooses).
 */
export function resolveOpenRouterHostRouting(input: {
  choices: Readonly<Record<string, OpenRouterHostChoice>>;
  rules?: OpenRouterHostRules | null;
  hosts?: readonly Pick<OpenRouterHost, "slug" | "supportsTools">[] | null;
  base?: LaneAProviderRouting | null;
}): LaneAProviderRouting | null {
  const max = LANE_A_PROVIDER_ROUTING_MAX_ENTRIES;
  const preferred = cleanOpenRouterHostList(input.rules?.preferred ?? []);
  const blocked = cleanOpenRouterHostList(input.rules?.blocked ?? []);
  const entries = Object.entries(input.choices).filter(([slug]) => OPENROUTER_HOST_SLUG_RE.test(slug));
  const explicitUse = entries.filter(([, choice]) => choice === "use").map(([slug]) => slug);
  const explicitNever = entries.filter(([, choice]) => choice === "never").map(([slug]) => slug);

  let only: string[] = explicitUse;
  if (only.length === 0 && preferred.length > 0 && input.hosts && input.hosts.length > 0) {
    const running = preferred.filter(
      (slug) => !explicitNever.includes(slug) && input.hosts!.some((host) => host.slug === slug),
    );
    const withTools = running.some((slug) => input.hosts!.some((host) => host.slug === slug && host.supportsTools));
    if (withTools) only = running;
  }
  only = only.slice(0, max);

  // Every blocked host is listed, also one that does not run this model
  // today: hosts come and go, and a blocked one must stay out if it appears.
  const ignore = [...new Set([...explicitNever, ...blocked.filter((slug) => !explicitUse.includes(slug))])]
    .filter((slug) => !only.includes(slug))
    .slice(0, max);

  const order = (input.base?.order ?? []).filter((slug) => !ignore.includes(slug));
  const out: LaneAProviderRouting = {};
  if (only.length > 0) out.only = only;
  if (order.length > 0) out.order = order;
  if (ignore.length > 0) out.ignore = ignore;
  if (typeof input.base?.allowFallbacks === "boolean") out.allowFallbacks = input.base.allowFallbacks;
  else if (explicitUse.length > 0 && !input.base) out.allowFallbacks = false;
  return out.only || out.order || out.ignore ? out : null;
}

/**
 * The routing one OpenRouter request is actually sent with: the setup's own
 * routing plus the company's blocked hosts in "ignore", read at call time so
 * setups saved before a host was blocked are covered too. A host the setup
 * explicitly lists under "only" (marked "Use") is not added: an explicit Use
 * still wins (rule 1 above). Blocked hosts are also dropped from "order".
 * Null = no host rule at all (OpenRouter chooses).
 */
export function withOpenRouterBlockedHostsForCall(
  routing: LaneAProviderRouting | null | undefined,
  blocked: readonly string[] | null | undefined,
): LaneAProviderRouting | null {
  const current = routing ?? null;
  const only = current?.only ?? [];
  const add = cleanOpenRouterHostList(blocked ?? []).filter((slug) => !only.includes(slug));
  if (add.length === 0) return current;
  // The blocked hosts go first, so the limit can never push one out.
  const ignore = [...new Set([...add, ...(current?.ignore ?? [])])].slice(0, LANE_A_PROVIDER_ROUTING_MAX_ENTRIES);
  const out: LaneAProviderRouting = { ...(current ?? {}), ignore };
  if (current?.order) {
    const order = current.order.filter((slug) => !ignore.includes(slug));
    if (order.length > 0) out.order = order;
    else delete out.order;
  }
  return out;
}

/**
 * The hosts a routing lets OpenRouter pick for this model: the "only" list
 * (or every host when there is none) minus the "ignore" list.
 */
export function openRouterHostsAllowed<T extends Pick<OpenRouterHost, "slug">>(
  routing: Pick<LaneAProviderRouting, "only" | "ignore"> | null | undefined,
  hosts: readonly T[],
): T[] {
  const only = routing?.only ?? [];
  const ignore = routing?.ignore ?? [];
  return hosts.filter((host) => (only.length === 0 || only.includes(host.slug)) && !ignore.includes(host.slug));
}

/** The plain warning when a routing leaves no host with tool calling (null when fine or nothing is known). */
export const OPENROUTER_NO_TOOL_HOST_WARNING =
  "No host you allow supports tool calling for this model, so a quick agent cannot use pictures, weather or hand-overs with it.";

export function openRouterNoToolHostWarning(
  routing: Pick<LaneAProviderRouting, "only" | "ignore"> | null | undefined,
  hosts: readonly Pick<OpenRouterHost, "slug" | "supportsTools">[] | null | undefined,
): string | null {
  if (!hosts || hosts.length === 0) return null;
  return openRouterHostsAllowed(routing, hosts).some((host) => host.supportsTools) ? null : OPENROUTER_NO_TOOL_HOST_WARNING;
}

/** What a setup remembers from a host check (specs.openrouterHostsSeen). */
export function openRouterHostsSeen(hosts: readonly Pick<OpenRouterHost, "slug" | "supportsTools">[]): OpenRouterHostSeen[] {
  const out: OpenRouterHostSeen[] = [];
  for (const host of hosts) {
    if (out.some((seen) => seen.slug === host.slug)) {
      // One host can list several endpoints (e.g. two quantisations): tools if any of them has it.
      if (host.supportsTools) out.find((seen) => seen.slug === host.slug)!.tools = true;
      continue;
    }
    out.push({ slug: host.slug, tools: host.supportsTools });
    if (out.length >= OPENROUTER_HOSTS_SEEN_MAX) break;
  }
  return out;
}

export interface OpenRouterHostsChange {
  added: string[];
  removed: string[];
  /** Hosts that support tool calling now and did not before. */
  toolsGained: string[];
  /** Hosts that supported tool calling before and no longer do. */
  toolsLost: string[];
}

/** What changed between the last remembered host list and the current one. */
export function diffOpenRouterHosts(
  previous: readonly OpenRouterHostSeen[],
  current: readonly OpenRouterHostSeen[],
): OpenRouterHostsChange {
  const before = new Map(previous.map((seen) => [seen.slug, seen.tools]));
  const after = new Map(current.map((seen) => [seen.slug, seen.tools]));
  const change: OpenRouterHostsChange = { added: [], removed: [], toolsGained: [], toolsLost: [] };
  for (const [slug, tools] of after) {
    if (!before.has(slug)) change.added.push(slug);
    else if (tools && !before.get(slug)) change.toolsGained.push(slug);
    else if (!tools && before.get(slug)) change.toolsLost.push(slug);
  }
  for (const slug of before.keys()) if (!after.has(slug)) change.removed.push(slug);
  return change;
}

/** "2 new hosts (novita, parasail); venice lost tool support", or "Nothing changed." */
export function describeOpenRouterHostsChange(change: OpenRouterHostsChange): string {
  const parts: string[] = [];
  const list = (slugs: string[]) => slugs.join(", ");
  if (change.added.length > 0) {
    parts.push(`${change.added.length === 1 ? "New host" : `${change.added.length} new hosts`}: ${list(change.added)}`);
  }
  if (change.removed.length > 0) {
    parts.push(`${change.removed.length === 1 ? "Gone" : `${change.removed.length} gone`}: ${list(change.removed)}`);
  }
  if (change.toolsGained.length > 0) parts.push(`Now supports tool calling: ${list(change.toolsGained)}`);
  if (change.toolsLost.length > 0) parts.push(`No longer supports tool calling: ${list(change.toolsLost)}`);
  return parts.length > 0 ? `${parts.join(". ")}.` : "Nothing changed.";
}

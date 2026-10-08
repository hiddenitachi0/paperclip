import {
  LANE_A_PROVIDER_CATALOGUE,
  laneAModelAcceptsReasoningEffort,
  laneAModelIssueForProvider,
  laneAModelPricing,
  normalizeLaneAProvider,
  type LaneAProvider,
  type LaneAProviderRouting,
} from "./lane-a-models.js";
import { findKnownVariant, variantFitsGpu } from "./known-models.js";
import { modelCannotRunReason, type ModelHealthStatus } from "./model-health.js";
import { openRouterHostsAllowed, withOpenRouterBlockedHostsForCall } from "./openrouter-hosts.js";
import type {
  ModelDirectoryAvailability,
  ModelDirectoryLane,
  ModelDirectorySpecs,
} from "./validators/model-directory.js";

/**
 * Model readiness: "is everything in place for this model to answer a quick
 * agent?", worked out instantly from what Paperclip already knows (the saved
 * setup, the last model-server resync / health check, the company's settings,
 * the agent's keys and the last real check). Nothing here calls a model or
 * the network, so it is free to show next to every picker option.
 *
 * Two shapes:
 *  - modelOptionStatus(): one short word for a picker option ("Installed",
 *    "Needs a key") plus one plain line for under the select;
 *  - modelReadiness(): the full checklist (ok / warn / fail / unknown lines,
 *    each with a one-line reason and, where there is one, a fix link).
 */

/** How old the last model-server reading may be before it says "last checked X ago". */
export const MODEL_READINESS_STALE_AFTER_MS = 60 * 60_000;
/** The context a quick agent needs: its tools, instructions and recent history. */
export const QUICK_AGENT_MIN_CONTEXT_TOKENS = 8_192;
/** Where models, the graphics card memory and the model server address are set. */
export const MODEL_SETTINGS_PATH = "/company/settings/models";
/** Where saved keys live. */
export const CONNECTIONS_PATH = "/company/settings/connections";

export type ModelReadinessStatus = "ok" | "warn" | "fail" | "unknown";

export interface ModelReadinessFix {
  label: string;
  href: string;
}

export interface ModelReadinessLine {
  id: string;
  status: ModelReadinessStatus;
  label: string;
  reason: string;
  fix?: ModelReadinessFix | null;
}

/**
 * The agent's key for this model, as the agent page works it out:
 *  - "set": a saved key will be sent;
 *  - "missing": a key is needed and none is picked;
 *  - "paperclip": Claude on Paperclip's own key;
 *  - "paperclip_missing": Claude with no key of its own and no Paperclip key either;
 *  - "not_needed": a local model (usually needs none);
 *  - "wrong_address": a key exists but is never sent to this address;
 *  - undefined: not known here (Settings > Models has no agent).
 */
export type ModelKeyState = "set" | "missing" | "paperclip" | "paperclip_missing" | "not_needed" | "wrong_address";

/** What the last real "Check this setup" call found (kept by the page that ran it). */
export interface ModelLastCheck {
  ok: boolean;
  checkedAt: string;
  toolCalling?: LaneASetupCheckToolCalling | null;
  thinkingAccepted?: boolean | null;
  summary?: string | null;
}

/** One model as the checklist sees it: a saved setup, or an agent's own main model / backup. */
export interface ModelSetupForReadiness {
  provider: string;
  model: string;
  baseUrl?: string | null;
  providerRouting?: LaneAProviderRouting | null;
  thinking?: string | null;
  temperature?: number | null;
  lane?: ModelDirectoryLane | null;
  availability?: ModelDirectoryAvailability | null;
  specs?: ModelDirectorySpecs | null;
  archived?: boolean;
}

/** One OpenRouter host as far as the checklist needs it (live host list, or what a setup remembers). */
export interface ReadinessOpenRouterHost {
  slug: string;
  supportsTools: boolean;
  supportsReasoning?: boolean | null;
  priceInPerM?: number | null;
  priceOutPerM?: number | null;
}

export interface ModelReadinessContext {
  now?: Date;
  key?: ModelKeyState;
  /** The company's model server address (Settings > Models), used when the setup has none. */
  companyLocalBaseUrl?: string | null;
  /** The company's graphics card memory in GB (Settings > Models). */
  gpuVramGb?: number | null;
  /** The last model-server reading for this address + model (resync or health check). */
  health?: { status: ModelHealthStatus; lastCheckedAt: string | null } | null;
  /** Live OpenRouter hosts for this model, when the page has them. Empty array = OpenRouter lists none. */
  openrouterHosts?: readonly ReadinessOpenRouterHost[] | null;
  /** The company's never-use OpenRouter hosts. */
  blockedHosts?: readonly string[] | null;
  /** True when the agent's tools hand it pictures to look at. */
  needsVision?: boolean;
  lastCheck?: ModelLastCheck | null;
}

// ─── Small helpers ─────────────────────────────────────────────────────────

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function formatTimeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "never";
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function isStale(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return true;
  const at = new Date(iso).getTime();
  return !Number.isFinite(at) || now.getTime() - at > MODEL_READINESS_STALE_AFTER_MS;
}

function localAddressOf(setup: ModelSetupForReadiness, ctx: ModelReadinessContext): string | null {
  const own = setup.baseUrl?.trim();
  if (own) return own;
  const company = ctx.companyLocalBaseUrl?.trim();
  return company || null;
}

function knownFacts(setup: ModelSetupForReadiness) {
  const match = findKnownVariant(setup.provider, setup.model);
  const variant = match?.variant ?? null;
  const specs = setup.specs ?? null;
  return {
    variant,
    tools: specs?.tools ?? variant?.tools ?? null,
    thinking: specs?.thinking ?? variant?.thinking ?? null,
    vision: specs?.vision ?? variant?.vision ?? null,
    contextTokens: specs?.contextTokens ?? variant?.contextTokens ?? null,
  };
}

function money(perMillion: number): string {
  return `$${perMillion < 0.1 ? perMillion.toFixed(3) : perMillion.toFixed(2)}`;
}

// ─── Picker status (one word per option) ───────────────────────────────────

export type ModelOptionStatusKind =
  | "installed"
  | "not_installed"
  | "downloading"
  | "unknown"
  | "offline"
  | "key_set"
  | "needs_key"
  | "paperclip_key"
  | "archived"
  | "broken";

export interface ModelOptionStatus {
  kind: ModelOptionStatusKind;
  /** One word or two, for the end of the option text: "Installed", "Needs a key". */
  label: string;
  /** One plain line for under the select. */
  detail: string;
  tone: "ok" | "warn" | "fail" | "unknown";
}

/**
 * The status shown on a picker option and under the select. A local model:
 * Installed / Not installed / Downloading / Offline / Unknown, from the last
 * resync or health check (with "last checked X ago" when that is over an
 * hour old). A hosted model: whether THIS agent has the key it needs.
 */
export function modelOptionStatus(setup: ModelSetupForReadiness, ctx: ModelReadinessContext = {}): ModelOptionStatus {
  const now = ctx.now ?? new Date();
  const provider = normalizeLaneAProvider(setup.provider);
  const label = LANE_A_PROVIDER_CATALOGUE[provider].label;
  const broken =
    modelCannotRunReason({ provider, model: setup.model, baseUrl: provider === "local" ? localAddressOf(setup, ctx) : setup.baseUrl ?? null }) ??
    (provider === "local" ? null : laneAModelIssueForProvider(provider, setup.model));
  if (broken) return { kind: "broken", label: "Can't run", detail: broken, tone: "fail" };
  if (setup.archived) {
    return {
      kind: "archived",
      label: "Archived",
      detail: "This saved model is archived. It still works, but it is hidden from new picks. Restore it in Settings > Models.",
      tone: "warn",
    };
  }

  if (provider === "local") {
    const health = ctx.health ?? null;
    const when = health?.lastCheckedAt ? ` (last checked ${formatTimeAgo(health.lastCheckedAt, now)})` : "";
    const staleNote = health && isStale(health.lastCheckedAt, now) ? when : "";
    if (health?.status === "unreachable") {
      return {
        kind: "offline",
        label: "Offline",
        detail: `The model server could not be reached${when}. Switch on the computer that runs it, then press Refresh status.`,
        tone: "fail",
      };
    }
    if (setup.availability === "downloading") {
      return { kind: "downloading", label: "Downloading", detail: `Still downloading on the model server${staleNote}.`, tone: "warn" };
    }
    if (health?.status === "ready") {
      return { kind: "installed", label: "Installed", detail: `Installed on the model server${staleNote || when}.`, tone: "ok" };
    }
    if (health?.status === "model_missing") {
      return {
        kind: "not_installed",
        label: "Not installed",
        detail: `The model server is on, but this model is not installed on it${staleNote || when}.${setup.specs?.pullCommand ? ` Install it with: ${setup.specs.pullCommand}` : ""}`,
        tone: "fail",
      };
    }
    if (setup.availability === "installed") {
      return { kind: "installed", label: "Installed", detail: "Marked installed at the last model list refresh. Press Refresh status to check now.", tone: "ok" };
    }
    if (setup.availability === "planned") {
      return { kind: "not_installed", label: "Not installed", detail: "Not installed on the model server yet (as far as Paperclip knows). Press Refresh status to check now.", tone: "fail" };
    }
    return { kind: "unknown", label: "Unknown", detail: "Not checked yet. Press Refresh status to ask the model server.", tone: "unknown" };
  }

  switch (ctx.key) {
    case "set":
      return { kind: "key_set", label: "Key set", detail: `This agent has a ${label} key for it.`, tone: "ok" };
    case "paperclip":
      return { kind: "paperclip_key", label: "Paperclip's key", detail: "Runs on Paperclip's own Claude key.", tone: "ok" };
    case "paperclip_missing":
      return {
        kind: "needs_key",
        label: "Needs a key",
        detail: "This agent has no Claude key and Paperclip's own Claude key is not set. Add one under Connections.",
        tone: "fail",
      };
    case "wrong_address":
      return {
        kind: "needs_key",
        label: "Needs a key",
        detail: `This agent's ${label} key was picked for a different address, so it is not sent here.`,
        tone: "fail",
      };
    case "missing":
      return { kind: "needs_key", label: "Needs a key", detail: `This agent has no ${label} key yet. Pick one after choosing this model.`, tone: "fail" };
    default:
      return { kind: "unknown", label: "Unknown", detail: `Each agent that uses it needs its own ${label} key.`, tone: "unknown" };
  }
}

// ─── The checklist ─────────────────────────────────────────────────────────

function keyLine(provider: LaneAProvider, ctx: ModelReadinessContext): ModelReadinessLine {
  const label = LANE_A_PROVIDER_CATALOGUE[provider].label;
  const fix = { label: "Add a key under Connections", href: CONNECTIONS_PATH };
  const base = { id: "key", label: `${label} key for this agent` };
  switch (ctx.key) {
    case "set":
      return { ...base, status: "ok", reason: "A saved key is picked and will be sent." };
    case "paperclip":
      return { ...base, status: "ok", reason: "No key of its own, so it uses Paperclip's own Claude key." };
    case "paperclip_missing":
      return { ...base, status: "fail", reason: "No key of its own, and Paperclip's own Claude key is not set either.", fix };
    case "wrong_address":
      return {
        ...base,
        status: "fail",
        reason: `A ${label} key is saved, but for a different address, so it is never sent here. Clear the address or pick the key again.`,
      };
    case "missing":
      return { ...base, status: "fail", reason: `No ${label} key is picked for this agent yet. Pick one under the model settings.`, fix };
    default:
      return { ...base, status: "unknown", reason: `Each agent that uses this model needs its own ${label} key.` };
  }
}

function lastCheckLine(ctx: ModelReadinessContext, now: Date): ModelReadinessLine {
  const check = ctx.lastCheck ?? null;
  if (!check) {
    return {
      id: "last_check",
      status: "unknown",
      label: "Last real check",
      reason: 'Not run yet. "Check this setup" sends one tiny message (costs a fraction of a cent) to prove it works.',
    };
  }
  return {
    id: "last_check",
    status: check.ok ? "ok" : "fail",
    label: "Last real check",
    reason: `${check.ok ? "Passed" : "Failed"} ${formatTimeAgo(check.checkedAt, now)}.${check.summary ? ` ${check.summary}` : ""}`,
  };
}

function laneLine(setup: ModelSetupForReadiness): ModelReadinessLine {
  const base = { id: "lane", label: "Suitable for quick chat" };
  if (setup.lane === "quick" || setup.lane === "both") return { ...base, status: "ok", reason: "Marked as good for quick agents." };
  if (setup.lane === "full") {
    return { ...base, status: "warn", reason: "Marked for full agents only. It may be slow or costly for quick chat." };
  }
  return { ...base, status: "unknown", reason: "Not marked either way. You can mark it when you edit the saved model." };
}

function toolsLineFromFacts(tools: "yes" | "partial" | "no" | null, ctx: ModelReadinessContext): ModelReadinessLine {
  const base = { id: "tools", label: "Tool calling" };
  const live = ctx.lastCheck?.toolCalling;
  if (live === "works") return { ...base, status: "ok", reason: "Worked in the last real check." };
  if (live === "not_supported" || live === "not_used") {
    return {
      ...base,
      status: "fail",
      reason:
        live === "not_supported"
          ? "The last real check found it cannot use tools, so it cannot make pictures, check the weather or hand work over."
          : "In the last real check it answered without using the test tool. Tools may not work reliably with it.",
    };
  }
  if (tools === "yes") return { ...base, status: "ok", reason: "Known to support tool calling." };
  if (tools === "partial") return { ...base, status: "warn", reason: "Tool calling only partly works with this model." };
  if (tools === "no") {
    return { ...base, status: "fail", reason: "This model cannot use tools: no pictures, weather or hand-overs. It can still chat." };
  }
  return { ...base, status: "unknown", reason: 'Not known. "Check this setup" tries one tool call.' };
}

function thinkingLine(
  setup: ModelSetupForReadiness,
  provider: LaneAProvider,
  thinkingKind: "yes" | "no" | "toggle" | null,
  ctx: ModelReadinessContext,
  allowedHosts: readonly ReadinessOpenRouterHost[] | null,
): ModelReadinessLine {
  const base = { id: "thinking", label: "Thinking setting" };
  const setting = setup.thinking === "on" || setup.thinking === "off" ? setup.thinking : null;
  if (ctx.lastCheck?.thinkingAccepted === false && setting === "off") {
    return { ...base, status: "warn", reason: 'The last real check showed the "off" setting is refused here, so Paperclip leaves it out.' };
  }
  if (setting === null) return { ...base, status: "ok", reason: "Model default: the model decides." };
  if (setting === "on" && thinkingKind === "no") {
    return { ...base, status: "warn", reason: 'Set to "on", but this model cannot think, so the setting does nothing.' };
  }
  if (setting === "off" && thinkingKind === "yes") {
    return {
      ...base,
      status: "warn",
      reason: 'Set to "off", but this model always thinks (like DeepSeek R1). Replies stay slower than you may expect.',
    };
  }
  if (setting === "off" && !laneAModelAcceptsReasoningEffort(provider, setup.model)) {
    return { ...base, status: "warn", reason: `"Off" is not sent to ${LANE_A_PROVIDER_CATALOGUE[provider].label} for this model, so the model decides.` };
  }
  if (setting === "off" && allowedHosts && allowedHosts.length > 0 && allowedHosts.every((h) => h.supportsReasoning === false)) {
    return {
      ...base,
      status: "warn",
      reason: 'None of the allowed hosts takes the thinking setting. Paperclip drops it and tries again, which adds a little delay.',
    };
  }
  return { ...base, status: "ok", reason: `Set to "${setting}".` };
}

/**
 * The full readiness checklist for one model setup. Lines are in a fixed
 * order; a line that does not apply (vision when nothing needs pictures) is
 * left out.
 */
export function modelReadiness(setup: ModelSetupForReadiness, ctx: ModelReadinessContext = {}): ModelReadinessLine[] {
  const now = ctx.now ?? new Date();
  const provider = normalizeLaneAProvider(setup.provider);
  const facts = knownFacts(setup);
  const lines: ModelReadinessLine[] = [];
  const settingsFix = { label: "Open Settings > Models", href: MODEL_SETTINGS_PATH };

  if (setup.archived) {
    lines.push({
      id: "archived",
      status: "warn",
      label: "Saved model",
      reason: "Archived: it still works for agents that use it, but it is hidden from new picks.",
      fix: settingsFix,
    });
  }

  if (provider === "local") {
    const address = localAddressOf(setup, ctx);
    const cannot = modelCannotRunReason({ provider, model: setup.model, baseUrl: address });
    const health = ctx.health ?? null;
    const when = health?.lastCheckedAt ? formatTimeAgo(health.lastCheckedAt, now) : null;
    const stale = health ? isStale(health.lastCheckedAt, now) : true;

    // 1. Installed on the model server.
    const option = modelOptionStatus(setup, ctx);
    lines.push({
      id: "installed",
      status:
        option.kind === "installed" ? "ok"
        : option.kind === "downloading" ? "warn"
        : option.kind === "not_installed" || option.kind === "broken" ? "fail"
        : "unknown",
      label: "Installed on the model server",
      reason: option.kind === "offline" ? "Unknown while the model server cannot be reached." : option.detail,
      fix: option.kind === "not_installed" || option.kind === "unknown" ? settingsFix : null,
    });

    // 2. Address set and reachable recently.
    if (!address || cannot) {
      lines.push({
        id: "address",
        status: "fail",
        label: "Model server address",
        reason: cannot ?? "No address yet. Add the address of the computer that runs your models.",
        fix: { label: "Set the model server address", href: MODEL_SETTINGS_PATH },
      });
    } else if (health?.status === "unreachable") {
      lines.push({
        id: "address",
        status: "fail",
        label: "Model server reachable",
        reason: `${address} could not be reached ${when ?? "at the last check"}. Is the computer on and the model server running?`,
      });
    } else if (health && (health.status === "ready" || health.status === "model_missing")) {
      lines.push({
        id: "address",
        status: stale ? "warn" : "ok",
        label: "Model server reachable",
        reason: `${address} answered ${when ?? "recently"}.${stale ? " That was a while ago; press Refresh status." : ""}`,
      });
    } else {
      lines.push({
        id: "address",
        status: "unknown",
        label: "Model server reachable",
        reason: `${address} has not been checked yet. Press Refresh status.`,
      });
    }

    // 3. Fits the graphics card.
    const gpu = ctx.gpuVramGb ?? null;
    const fit = facts.variant ? variantFitsGpu(facts.variant, gpu) : null;
    const fitBase = { id: "gpu", label: "Fits the graphics card" };
    if (gpu === null || gpu === undefined || !(gpu > 0)) {
      lines.push({ ...fitBase, status: "unknown", reason: "Set your graphics card memory to see whether it fits.", fix: { label: "Set your graphics card memory", href: MODEL_SETTINGS_PATH } });
    } else if (fit === "yes" || (!fit && setup.specs?.fitsLocalGpu === "yes")) {
      lines.push({ ...fitBase, status: "ok", reason: `Fits a ${gpu} GB card.` });
    } else if (fit === "tight" || (!fit && setup.specs?.fitsLocalGpu === "tight")) {
      lines.push({ ...fitBase, status: "warn", reason: `Only just fits a ${gpu} GB card. Long chats may slow down or spill into normal memory.` });
    } else if (fit === "no" || (!fit && setup.specs?.fitsLocalGpu === "no")) {
      lines.push({ ...fitBase, status: "fail", reason: `Needs more than your ${gpu} GB card has. It will be very slow, or not load at all.` });
    } else {
      lines.push({ ...fitBase, status: "unknown", reason: "Paperclip does not know how much memory this model needs." });
    }

    // 4. Context length.
    const ctxHint = "Ollama uses a small context (often 4k) unless OLLAMA_CONTEXT_LENGTH is set on the model server; set it to 8192 or more.";
    const contextTokens = facts.contextTokens;
    if (contextTokens === null) {
      lines.push({ id: "context", status: "unknown", label: "Context length", reason: `Not known. ${ctxHint}` });
    } else if (contextTokens >= QUICK_AGENT_MIN_CONTEXT_TOKENS) {
      lines.push({ id: "context", status: "ok", label: "Context length", reason: `${contextTokens.toLocaleString("en-US")} tokens is enough. ${ctxHint}` });
    } else {
      lines.push({
        id: "context",
        status: "fail",
        label: "Context length",
        reason: `${contextTokens.toLocaleString("en-US")} tokens is too little for a quick agent's tools and history (about ${QUICK_AGENT_MIN_CONTEXT_TOKENS.toLocaleString("en-US")} needed).`,
      });
    }

    lines.push(toolsLineFromFacts(facts.tools, ctx));
    lines.push(laneLine(setup));
    lines.push(thinkingLine(setup, provider, facts.thinking, ctx, null));

    // 8. Temperature.
    if (typeof setup.temperature === "number") {
      lines.push({ id: "temperature", status: "ok", label: "Creativity", reason: `Set to ${setup.temperature}.` });
    } else {
      lines.push({
        id: "temperature",
        status: "warn",
        label: "Creativity",
        reason: "Not set, so the model server picks (Ollama often uses 1.0, which makes answers wander). Pick a creativity level.",
      });
    }
  } else {
    lines.push(keyLine(provider, ctx));

    // Address.
    const descriptor = LANE_A_PROVIDER_CATALOGUE[provider];
    const custom = setup.baseUrl?.trim() || null;
    if (!descriptor.baseUrlEditable || !custom) {
      lines.push({ id: "address", status: "ok", label: "Address", reason: `Uses ${descriptor.label}'s own address.` });
    } else if (/^https:\/\//i.test(custom) || /^http:\/\/(localhost|127\.|10\.|192\.168\.|100\.)/i.test(custom)) {
      lines.push({ id: "address", status: "ok", label: "Address", reason: `Uses the saved address ${custom}.` });
    } else {
      lines.push({ id: "address", status: "fail", label: "Address", reason: `${custom} does not look like a web address (it should start with https://).` });
    }

    let allowed: ReadinessOpenRouterHost[] | null = null;
    if (provider === "openrouter") {
      const live = ctx.openrouterHosts ?? null;
      const seen = setup.specs?.openrouterHostsSeen ?? null;
      const knownOption = facts.variant?.openrouter.find((o) => o.id.toLowerCase() === setup.model.trim().toLowerCase().replace(/:[^/:]*$/, "")) ?? facts.variant?.openrouter[0] ?? null;
      const hosts: ReadinessOpenRouterHost[] | null =
        live ? [...live]
        : seen && seen.length > 0 ? seen.map((h) => ({ slug: h.slug, supportsTools: h.tools }))
        : knownOption ? knownOption.toolHosts.map((slug) => ({ slug, supportsTools: true }))
        : null;
      const hostSource = live ? "OpenRouter's host list" : seen && seen.length > 0 ? "the last host refresh" : "Paperclip's model list";

      // Model exists.
      if (live && live.length === 0) {
        lines.push({ id: "exists", status: "fail", label: "Model on OpenRouter", reason: "OpenRouter lists no hosts for this model id. Check the spelling." });
      } else if (hosts && hosts.length > 0) {
        lines.push({ id: "exists", status: "ok", label: "Model on OpenRouter", reason: `Found (${hostSource}).` });
      } else {
        lines.push({ id: "exists", status: "unknown", label: "Model on OpenRouter", reason: "Not checked yet. Refresh the hosts in Settings > Models, or run a real check.", fix: settingsFix });
      }

      // Host rules.
      const routing = withOpenRouterBlockedHostsForCall(setup.providerRouting ?? null, ctx.blockedHosts ?? []);
      if (hosts && hosts.length > 0) {
        allowed = openRouterHostsAllowed(routing, hosts);
        if (allowed.length === 0) {
          lines.push({
            id: "hosts_left",
            status: "fail",
            label: "Allowed hosts",
            reason: "Your host rules (this model's list plus the company's blocked hosts) leave no host at all.",
            fix: settingsFix,
          });
          lines.push({ id: "tool_hosts", status: "fail", label: "Tool calling", reason: "No host is left to run it." });
        } else {
          lines.push({ id: "hosts_left", status: "ok", label: "Allowed hosts", reason: `${allowed.length} of ${hosts.length} host${hosts.length === 1 ? "" : "s"} allowed.` });
          const toolHosts = allowed.filter((h) => h.supportsTools).length;
          const live2 = ctx.lastCheck?.toolCalling;
          if (live2 === "works") lines.push({ id: "tool_hosts", status: "ok", label: "Tool calling", reason: "Worked in the last real check." });
          else if (toolHosts > 0) lines.push({ id: "tool_hosts", status: "ok", label: "Tool calling", reason: `${toolHosts} allowed host${toolHosts === 1 ? "" : "s"} support${toolHosts === 1 ? "s" : ""} tools.` });
          else lines.push({ id: "tool_hosts", status: "fail", label: "Tool calling", reason: "No allowed host supports tool calling, so no pictures, weather or hand-overs.", fix: settingsFix });
        }
      } else {
        lines.push({ id: "hosts_left", status: "unknown", label: "Allowed hosts", reason: "Host list not known yet." });
        lines.push(toolsLineFromFacts(facts.tools, ctx));
      }
    } else {
      const issue = laneAModelIssueForProvider(provider, setup.model);
      lines.push(
        issue
          ? { id: "exists", status: "fail", label: `Model on ${descriptor.label}`, reason: issue }
          : { id: "exists", status: "ok", label: `Model on ${descriptor.label}`, reason: descriptor.freeForm ? "Typed in by hand; a real check confirms it exists." : "One of the models Paperclip knows." },
      );
      lines.push(toolsLineFromFacts(facts.tools ?? (descriptor.freeForm ? null : "yes"), ctx));
    }

    lines.push(laneLine(setup));
    lines.push(thinkingLine(setup, provider, facts.thinking, ctx, allowed));

    // Price.
    const fixed = laneAModelPricing(provider, setup.model);
    const priced = (allowed ?? []).filter((h) => typeof h.priceInPerM === "number" && typeof h.priceOutPerM === "number");
    const cheapest = priced.sort((a, b) => a.priceInPerM! + a.priceOutPerM! - (b.priceInPerM! + b.priceOutPerM!))[0];
    const known = facts.variant?.openrouter.find((o) => typeof o.priceIn === "number" && typeof o.priceOut === "number");
    const price =
      fixed ? { in: fixed.inputUsdPerMillion, out: fixed.outputUsdPerMillion }
      : cheapest ? { in: cheapest.priceInPerM!, out: cheapest.priceOutPerM! }
      : provider === "openrouter" && known ? { in: known.priceIn!, out: known.priceOut! }
      : null;
    lines.push(
      price
        ? { id: "price", status: "ok", label: "Price", reason: `About ${money(price.in)} in / ${money(price.out)} out per million tokens.` }
        : { id: "price", status: "unknown", label: "Price", reason: "Paperclip has no price for it; its cost is recorded as 0 until it has one." },
    );
  }

  if (ctx.needsVision) {
    const vision = facts.vision;
    lines.push(
      vision === true ? { id: "vision", status: "ok", label: "Can look at pictures", reason: "This model can read pictures." }
      : vision === false ? { id: "vision", status: "warn", label: "Can look at pictures", reason: "This agent's tools hand it pictures, but this model cannot look at them." }
      : { id: "vision", status: "unknown", label: "Can look at pictures", reason: "Not known whether this model can look at pictures." },
    );
  }

  lines.push(lastCheckLine(ctx, now));
  return lines;
}

/** The checklist in one word, for a badge: the worst line wins (unknowns alone read "Not checked"). */
export function modelReadinessSummary(lines: readonly ModelReadinessLine[]): { status: ModelReadinessStatus; label: string } {
  const fails = lines.filter((l) => l.status === "fail").length;
  const warns = lines.filter((l) => l.status === "warn").length;
  if (fails > 0) return { status: "fail", label: `Not ready (${fails} to fix)` };
  if (warns > 0) return { status: "warn", label: `Ready, ${warns} to look at` };
  if (lines.some((l) => l.status === "ok")) return { status: "ok", label: "Ready" };
  return { status: "unknown", label: "Not checked" };
}

// ─── "Check this setup" (a real call) ──────────────────────────────────────

export const LANE_A_SETUP_CHECK_MIN_INTERVAL_MS = 10_000;

export type LaneASetupCheckTarget = "main" | { backupId: string };
export type LaneASetupCheckToolCalling = "works" | "not_supported" | "not_used" | "not_tested";
export type LaneASetupCheckStepId = "settings" | "key" | "reachable" | "model" | "answer" | "tools" | "thinking" | "temperature" | "cost";

export interface LaneASetupCheckStep {
  id: LaneASetupCheckStepId;
  /** True = fine, false = a problem, null = not tested (an earlier step stopped it). */
  ok: boolean | null;
  text: string;
}

export interface LaneASetupCheckResult {
  target: LaneASetupCheckTarget;
  provider: string;
  model: string | null;
  ok: boolean;
  /** One plain sentence: "Everything works." / "The key was refused." */
  summary: string;
  steps: LaneASetupCheckStep[];
  answerMs: number | null;
  toolCalling: LaneASetupCheckToolCalling;
  thinkingAccepted: boolean | null;
  costCents: number;
  costMicroUsd: number;
  checkedAt: string;
}

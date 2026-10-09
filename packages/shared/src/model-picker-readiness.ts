import { LANE_A_PROVIDER_CATALOGUE, normalizeLaneAProvider } from "./lane-a-models.js";
import {
  CONNECTIONS_PATH,
  MODEL_SETTINGS_PATH,
  formatTimeAgo,
  modelOptionStatus,
  type ModelReadinessContext,
  type ModelReadinessFix,
  type ModelSetupForReadiness,
} from "./model-readiness.js";
import type { ModelHealthReport } from "./model-health.js";
import type { ModelDirectoryEntry } from "./validators/model-directory.js";

/**
 * One readiness reading per model option in ANY model picker (quick agent
 * main model and backups, the Ask helper, add-ons such as Media Studio), so
 * every dropdown says the same thing the same way:
 *
 *   "✅ Ready", "⚠️ Not installed on office-pc", "⚠️ Never checked",
 *   "❌ Needs a key", "❌ Check failed", ...
 *
 * Worked out from what Paperclip already knows (the saved setup, the last
 * model-server resync / health reading, the company's model server address,
 * the agent's key and the last "Check this setup"), via modelOptionStatus().
 * Nothing here calls a model or the network, so it is free to show on every
 * option. Nothing about one company's computer is assumed: the machine name
 * comes from the model's own address, or the company's model server address.
 */

export type ModelPickerReadinessKind =
  | "ready"
  /** Hosted model; whether a key is there depends on where it is used. */
  | "key_per_use"
  | "never_checked"
  | "downloading"
  | "archived"
  | "not_installed"
  | "offline"
  | "needs_key"
  | "check_failed"
  | "cannot_run";

export interface ModelPickerReadiness {
  kind: ModelPickerReadinessKind;
  /** True only when everything known says it will answer. */
  ready: boolean;
  tone: "ok" | "warn" | "fail" | "unknown";
  icon: "✅" | "⚠️" | "❌" | "🔑";
  /** Icon plus a few words, for the option text: "⚠️ Not installed on office-pc". */
  badge: string;
  /** True for a model on the company's own model server. */
  local: boolean;
  /** "Local — installed" / "Local — not installed" / ...; null for a hosted model. */
  runLabel: string | null;
  /** One plain line describing the state (shown under the select when it is ready). */
  detail: string;
  /** One plain line with what to do, for under the select; null when ready. */
  warning: string | null;
  /** Where to fix it other than the Models page (for example Connections for a key). */
  fix: ModelReadinessFix | null;
  /** Sort order: 0 = ready first. */
  rank: number;
}

/** Where saved models, their status and "Refresh status" live. */
export const MODEL_PICKER_MODELS_PAGE = MODEL_SETTINGS_PATH;

const RANK: Record<ModelPickerReadinessKind, number> = {
  ready: 0,
  key_per_use: 1,
  never_checked: 2,
  downloading: 2,
  archived: 2,
  not_installed: 3,
  offline: 3,
  needs_key: 4,
  check_failed: 4,
  cannot_run: 5,
};

/**
 * A short name for the computer behind a model server address:
 * "http://office-pc:11434" -> "office-pc"; a loopback address is the
 * computer Paperclip itself runs on. Never assumes any one setup.
 */
export function modelServerName(address: string | null | undefined): string {
  const raw = (address ?? "").trim();
  if (!raw) return "the model server";
  let host = "";
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname;
  } catch {
    host = "";
  }
  host = host.replace(/^\[|\]$/g, "");
  if (!host) return "the model server";
  if (host === "localhost" || host === "::1" || /^127\./.test(host) || host === "0.0.0.0") return "the Paperclip server";
  return host;
}

function localAddress(setup: ModelSetupForReadiness, ctx: ModelReadinessContext): string | null {
  return setup.baseUrl?.trim() || ctx.companyLocalBaseUrl?.trim() || null;
}

const LOCAL_RUN_LABEL: Partial<Record<ModelPickerReadinessKind, string>> = {
  ready: "Local — installed",
  not_installed: "Local — not installed",
  never_checked: "Local — not checked yet",
  offline: "Local — model server offline",
  downloading: "Local — downloading",
};

const ICON: Record<ModelPickerReadinessKind, ModelPickerReadiness["icon"]> = {
  ready: "✅",
  key_per_use: "🔑",
  never_checked: "⚠️",
  downloading: "⚠️",
  archived: "⚠️",
  not_installed: "⚠️",
  offline: "⚠️",
  needs_key: "❌",
  check_failed: "❌",
  cannot_run: "❌",
};

const REFRESH = "then press Refresh status on the Models page";

/**
 * The readiness of one model for a picker option and the line under the
 * select. `ctx` is the same context modelOptionStatus() takes: pass `key`
 * when the page knows the agent's key, `health` from the last model-server
 * reading, `companyLocalBaseUrl` from Settings > Models, `lastCheck` from
 * the last "Check this setup".
 */
export function modelPickerReadiness(setup: ModelSetupForReadiness, ctx: ModelReadinessContext = {}): ModelPickerReadiness {
  const now = ctx.now ?? new Date();
  const provider = normalizeLaneAProvider(setup.provider);
  const local = provider === "local";
  const providerLabel = LANE_A_PROVIDER_CATALOGUE[provider].label;
  const machine = modelServerName(local ? localAddress(setup, ctx) : null);
  const option = modelOptionStatus(setup, ctx);
  const when = ctx.health?.lastCheckedAt ? ` (checked ${formatTimeAgo(ctx.health.lastCheckedAt, now)})` : "";
  const pull = setup.specs?.pullCommand?.trim();
  const connectionsFix: ModelReadinessFix = { label: "Add a key under Connections", href: CONNECTIONS_PATH };

  const build = (
    kind: ModelPickerReadinessKind,
    badgeWords: string,
    detail: string,
    warning: string | null,
    fix: ModelReadinessFix | null = null,
  ): ModelPickerReadiness => ({
    kind,
    ready: kind === "ready",
    tone: kind === "ready" ? "ok" : kind === "key_per_use" ? "unknown" : RANK[kind] >= 4 ? "fail" : "warn",
    icon: ICON[kind],
    badge: `${ICON[kind]} ${badgeWords}`,
    local,
    runLabel: local ? LOCAL_RUN_LABEL[kind] ?? "Local" : null,
    detail,
    warning,
    fix,
    rank: RANK[kind],
  });

  if (option.kind === "broken") {
    return build("cannot_run", "Can't run", option.detail, `${option.detail} Fix the saved model on the Models page, or pick another one.`);
  }
  const failedCheck = ctx.lastCheck && !ctx.lastCheck.ok ? ctx.lastCheck : null;
  if (failedCheck) {
    const said = failedCheck.summary?.trim() ? ` It said: ${failedCheck.summary.trim()}` : "";
    return build(
      "check_failed",
      "Check failed",
      `The last "Check this setup" failed ${formatTimeAgo(failedCheck.checkedAt, now)}.${said}`,
      `The last "Check this setup" failed ${formatTimeAgo(failedCheck.checkedAt, now)}.${said} Fix what it says, then run Check this setup again.`,
    );
  }
  if (option.kind === "archived") {
    return build("archived", "Archived", option.detail, option.detail);
  }
  const passedCheck = ctx.lastCheck?.ok ? ctx.lastCheck : null;

  switch (option.kind) {
    case "installed":
      return build("ready", "Ready", `Installed on ${machine}${when}.`, null);
    case "not_installed":
      return build(
        "not_installed",
        `Not installed on ${machine}`,
        `Not installed on ${machine}${when}.`,
        `This model is not installed on ${machine}${when}. Install it there${pull ? ` (${pull})` : ""}, ${REFRESH}.`,
      );
    case "downloading":
      return build("downloading", `Downloading on ${machine}`, `Still downloading on ${machine}.`, `Still downloading on ${machine}. When it is done, press Refresh status on the Models page.`);
    case "offline":
      return build(
        "offline",
        `${machine} is offline`,
        `${machine} could not be reached${when}.`,
        `${machine} could not be reached${when}. Switch it on and start the model server, ${REFRESH}.`,
      );
    case "unknown":
      if (local) {
        if (passedCheck) return build("ready", "Ready", `"Check this setup" passed ${formatTimeAgo(passedCheck.checkedAt, now)}.`, null);
        return build(
          "never_checked",
          "Never checked",
          `Paperclip has not asked ${machine} whether this model is installed yet.`,
          `Paperclip has not asked ${machine} whether this model is installed yet. Open the Models page and press Refresh status.`,
        );
      }
      return build(
        "key_per_use",
        "Needs its own key",
        `Runs on ${providerLabel}; whoever uses it needs a ${providerLabel} key.`,
        `Runs on ${providerLabel}, so it needs a ${providerLabel} key where it is used. Pick one, or add one under Connections.`,
        connectionsFix,
      );
    case "key_set":
    case "paperclip_key":
      return build("ready", "Ready", option.detail, null);
    case "needs_key":
      return build("needs_key", "Needs a key", option.detail, option.detail, connectionsFix);
    default:
      return build("never_checked", "Never checked", option.detail, option.detail);
  }
}

/** The option text in a picker: "✅ Ready · 3B · Local — installed (llama3.2:latest)". */
export function modelPickerOptionText(label: string, readiness: Pick<ModelPickerReadiness, "badge"> | null | undefined): string {
  return readiness ? `${readiness.badge} · ${label}` : label;
}

/** Ready models first, keeping the given order otherwise (stable). Items without a reading go last-but-one. */
export function sortByModelReadiness<T>(items: readonly T[], readinessOf: (item: T) => Pick<ModelPickerReadiness, "rank"> | null | undefined): T[] {
  return items
    .map((item, index) => ({ item, index, rank: readinessOf(item)?.rank ?? 1.5 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((row) => row.item);
}

/** A saved model (Settings > Models) as the readiness helpers see it. */
export function readinessSetupFromDirectoryEntry(
  entry: Pick<
    ModelDirectoryEntry,
    "provider" | "model" | "baseUrl" | "providerRouting" | "defaultThinking" | "defaultTemperature" | "lane" | "availability" | "specs" | "archivedAt"
  >,
): ModelSetupForReadiness {
  return {
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl,
    providerRouting: entry.providerRouting,
    thinking: entry.defaultThinking,
    temperature: entry.defaultTemperature,
    lane: entry.lane,
    availability: entry.availability,
    specs: entry.specs,
    archived: Boolean(entry.archivedAt),
  };
}

/** A stored model-server reading as the readiness helpers take it; "not checked" counts as no reading. */
export function readinessHealthReading(report: Pick<ModelHealthReport, "status" | "lastCheckedAt"> | null | undefined) {
  if (!report || report.status === "not_checked") return null;
  return { status: report.status, lastCheckedAt: report.lastCheckedAt };
}

/**
 * DUR-4419 (child of DUR-4378): local-model health, the offline reminder and
 * the test button. Pure helpers + wire types shared by the server and the UI.
 * Every string here is shown to the person verbatim, so it is plain English.
 */

/** The DUR-4357 local-model runbook (a document on that issue). */
export const LOCAL_MODEL_RUNBOOK_PATH = "/DUR/issues/DUR-4357#document-runbook";

export const MODEL_HEALTH_STATUSES = ["ready", "unreachable", "model_missing", "not_checked"] as const;
export type ModelHealthStatus = (typeof MODEL_HEALTH_STATUSES)[number];

export interface ModelHealthReport {
  status: ModelHealthStatus;
  /** Short, plain-English line for the green/red badge. */
  message: string;
  /** Extra plain-English detail (what to do next); null when Ready. */
  hint: string | null;
  /** Where the "see the runbook" link goes; null when Ready. */
  runbookPath: string | null;
  lastCheckedAt: string | null;
  /** When the current outage began; null when not in one. */
  outageStartedAt: string | null;
}

export interface ModelDirectoryEntryHealth extends ModelHealthReport {
  entryId: string;
  /** False for a hosted model: there is nothing to check, so status is "not_checked". */
  applicable: boolean;
}

export interface AgentModelHealth extends ModelHealthReport {
  agentId: string;
  agentName: string;
  entryId: string | null;
  /** True when the agent page should show the "can't reach" banner. */
  showBanner: boolean;
}

export interface ModelHealthOverview {
  entries: ModelDirectoryEntryHealth[];
  agents: AgentModelHealth[];
}

export interface ModelTestRun {
  thinking: "on" | "off" | "default";
  ok: boolean;
  answer: string | null;
  /** Milliseconds to the first word; null if none arrived. */
  firstWordMs: number | null;
  totalMs: number | null;
  /** Plain-English reason when ok is false. */
  error: string | null;
}

export interface ModelTestResult {
  entryId: string;
  /** False when the setup cannot be run at all; `reason` says why. */
  ran: boolean;
  reason: string | null;
  prompt: string;
  runs: ModelTestRun[];
}

export const MODEL_TEST_PROMPT = "Say hi in five words";

const CHECK_HINT = "Is it on, and is Ollama running? (Tailscale on; see the local-model runbook)";

export function modelHealthReport(
  status: ModelHealthStatus,
  opts: { model?: string; detail?: string | null; lastCheckedAt?: Date | string | null; outageStartedAt?: Date | string | null } = {},
): ModelHealthReport {
  const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
  const base = { lastCheckedAt: iso(opts.lastCheckedAt), outageStartedAt: iso(opts.outageStartedAt) };
  switch (status) {
    case "ready":
      return { status, message: "Ready", hint: null, runbookPath: null, ...base };
    case "unreachable":
      return { status, message: "Can't reach your PC.", hint: CHECK_HINT, runbookPath: LOCAL_MODEL_RUNBOOK_PATH, ...base };
    case "model_missing":
      return {
        status,
        message: `Your PC is on, but it doesn't have ${opts.model ? `"${opts.model}"` : "this model"} yet.`,
        hint: `Download it in Ollama first${opts.model ? ` (ollama pull ${opts.model})` : ""}; see the local-model runbook.`,
        runbookPath: LOCAL_MODEL_RUNBOOK_PATH,
        ...base,
      };
    default:
      return { status: "not_checked", message: "Not checked yet", hint: null, runbookPath: null, ...base };
  }
}

/** Identity of one local model on one address; the unit an outage is tracked against. */
export function normalizeLocalModelAddress(baseUrl: string | null | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

/** The once-per-outage message sent in the chat or Telegram thread. */
export function localModelOfflineNotice(opts: { agentName: string; backupModel?: string | null }): string {
  const who = `${opts.agentName}'s local model`;
  if (opts.backupModel) return `${who} is offline, answered with ${opts.backupModel}.`;
  return `${who} is offline, so I can't answer right now. Please turn on Ollama on your PC (and Tailscale), then try again.`;
}

/** The evening-before warning ahead of a scheduled job that needs the local model. */
export function localModelEveningWarning(opts: { agentName: string; jobName: string; time: string }): string {
  return `Heads-up: ${opts.agentName}'s local model has been unreachable for the last hour. Tomorrow's ${opts.jobName} (${opts.time}) needs it. Please turn on your PC and Ollama (and Tailscale) tonight.`;
}

/**
 * Why a saved setup can't be run at all, or null when a call is worth trying.
 * Plain English; shown as-is by the Test button.
 */
export function modelCannotRunReason(entry: { provider: string; model: string; baseUrl: string | null }): string | null {
  const model = entry.model.trim();
  if (/^https?:\/\/(www\.)?huggingface\.co\//i.test(model)) {
    return "This is a Hugging Face web page, not a model your PC can run. Use a GGUF version (hf.co/<user>/<repo>-GGUF:<quantisation>) and download it with Ollama first.";
  }
  if (/^hf\.co\//i.test(model) && !/gguf/i.test(model)) {
    return "This Hugging Face model has no GGUF file, which is the format Ollama needs. Pick a GGUF version of it.";
  }
  if (entry.provider === "local") {
    if (!entry.baseUrl || entry.baseUrl.trim().length === 0) {
      return "This local model has no address yet. Add your PC's address (over Tailscale) first.";
    }
    if (!/^https?:\/\//i.test(entry.baseUrl.trim())) {
      return "This local model's address isn't a web address (it should start with http://).";
    }
  }
  return null;
}

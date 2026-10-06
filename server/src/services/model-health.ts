import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, localModelHealth, modelDirectoryEntries } from "@paperclipai/db";
import {
  MODEL_TEST_PROMPT,
  laneAModelAcceptsReasoningEffort,
  modelCannotRunReason,
  modelHealthReport,
  normalizeLocalModelAddress,
  type AgentModelHealth,
  type ModelDirectoryEntryHealth,
  type ModelHealthOverview,
  type ModelHealthStatus,
  type ModelTestResult,
  type ModelTestRun,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { createModelSetupProbes } from "./model-setup-probes.js";

/**
 * DUR-4419: local-model health, the once-per-outage reminder state, and the
 * Test button. Outage state lives in local_model_health keyed by
 * (company, address, model); see that schema file for the fire-once design.
 * Nothing here ever reads or stores a key: a local server needs none.
 */

export const MODEL_HEALTH_PROBE_TIMEOUT_MS = 5_000;
export const MODEL_TEST_TIMEOUT_MS = 60_000;
/** How long the PC must have been unreachable before the evening warning goes out. */
export const MODEL_OUTAGE_WARN_AFTER_MS = 60 * 60_000;
/** One evening warning per outage, and never twice within this window. */
export const MODEL_EVENING_WARNING_WINDOW_MS = 18 * 3_600_000;

type FetchLike = typeof fetch;
type Row = typeof localModelHealth.$inferSelect;

export interface ModelHealthDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

/** Ollama's native API lives at the server root; the OpenAI-compatible address ends in /v1. */
function ollamaRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** Ollama lists "name:tag"; a bare name means ":latest". */
function modelListed(wanted: string, listed: string[]): boolean {
  const norm = (n: string) => (n.includes(":") ? n : `${n}:latest`).toLowerCase();
  const target = norm(wanted.trim());
  return listed.some((name) => norm(name) === target);
}

export type ProbeResult = { status: ModelHealthStatus; detail: string | null };

export async function probeLocalModel(
  baseUrl: string,
  model: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = MODEL_HEALTH_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${ollamaRoot(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { status: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { status: "unreachable", detail: `The address answered with HTTP ${res.status}.` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "unreachable", detail: "The address answered, but not like Ollama." };
  }
  const models = (body as { models?: Array<{ name?: string; model?: string }> } | null)?.models;
  if (!Array.isArray(models)) return { status: "unreachable", detail: "The address answered, but not like Ollama." };
  const names = models.flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === "string");
  return modelListed(model, names) ? { status: "ready", detail: null } : { status: "model_missing", detail: null };
}

export function modelHealthService(db: Db, deps: ModelHealthDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowOf = () => deps.now?.() ?? new Date();

  async function getRow(companyId: string, baseUrl: string, model: string): Promise<Row | null> {
    const [row] = await db
      .select()
      .from(localModelHealth)
      .where(and(eq(localModelHealth.companyId, companyId), eq(localModelHealth.baseUrl, baseUrl), eq(localModelHealth.model, model)));
    return row ?? null;
  }

  /**
   * Stores one observation and moves the outage state. Down keeps the original
   * outage start and notice flags; ready closes the outage and re-arms both
   * the offline reminder and the evening warning for the next one.
   */
  async function record(companyId: string, rawBaseUrl: string, model: string, status: Exclude<ModelHealthStatus, "not_checked">): Promise<Row> {
    const baseUrl = normalizeLocalModelAddress(rawBaseUrl);
    const now = nowOf();
    const down = status !== "ready";
    const reachable = status === "ready" || status === "model_missing";
    const base = { status, lastCheckedAt: now, updatedAt: now };
    // Outage columns are preserved/cleared in SQL (never from a stale JS read) so a
    // concurrent claimOutageNotice() cannot be clobbered by a racing record().
    const [row] = await db
      .insert(localModelHealth)
      .values({
        companyId, baseUrl, model, ...base,
        lastReachableAt: reachable ? now : null,
        outageStartedAt: down ? now : null,
        outageNotifiedAt: null,
        eveningWarnedAt: null,
      })
      .onConflictDoUpdate({
        target: [localModelHealth.companyId, localModelHealth.baseUrl, localModelHealth.model],
        set: {
          ...base,
          ...(reachable ? { lastReachableAt: now } : {}),
          outageStartedAt: down ? sql`coalesce(${localModelHealth.outageStartedAt}, ${now.toISOString()}::timestamptz)` : null,
          ...(down ? {} : { outageNotifiedAt: null, eveningWarnedAt: null }),
        },
      })
      .returning();
    return row!;
  }

  /**
   * True exactly once per outage: the first caller after the outage began
   * flips outage_notified_at in a single conditional UPDATE, so two
   * concurrent failed messages cannot both send the reminder either.
   */
  async function claimOutageNotice(companyId: string, rawBaseUrl: string, model: string): Promise<boolean> {
    const claimed = await db
      .update(localModelHealth)
      .set({ outageNotifiedAt: nowOf() })
      .where(
        and(
          eq(localModelHealth.companyId, companyId),
          eq(localModelHealth.baseUrl, normalizeLocalModelAddress(rawBaseUrl)),
          eq(localModelHealth.model, model),
          sql`${localModelHealth.status} <> 'ready'`,
          isNull(localModelHealth.outageNotifiedAt),
        ),
      )
      .returning({ id: localModelHealth.id });
    return claimed.length > 0;
  }

  /** What a chat turn reports after trying a local model: ok, or failed (unreachable / model missing). */
  async function noteLocalAttempt(params: {
    companyId: string;
    baseUrl: string;
    model: string;
    outcome: "ok" | "unreachable" | "model_missing";
  }): Promise<{ notify: boolean }> {
    await record(params.companyId, params.baseUrl, params.model, params.outcome === "ok" ? "ready" : params.outcome);
    if (params.outcome === "ok") return { notify: false };
    return { notify: await claimOutageNotice(params.companyId, params.baseUrl, params.model) };
  }

  function reportOf(row: Row | null, model: string) {
    if (!row) return modelHealthReport("not_checked");
    return modelHealthReport(row.status as ModelHealthStatus, {
      model,
      lastCheckedAt: row.lastCheckedAt,
      outageStartedAt: row.outageStartedAt,
    });
  }

  async function checkTarget(companyId: string, baseUrl: string, model: string) {
    const probe = await probeLocalModel(baseUrl, model, fetchImpl);
    const status = probe.status === "not_checked" ? "unreachable" : probe.status;
    const row = await record(companyId, baseUrl, model, status);
    return reportOf(row, model);
  }

  async function getEntry(companyId: string, entryId: string) {
    const [entry] = await db
      .select()
      .from(modelDirectoryEntries)
      .where(and(eq(modelDirectoryEntries.companyId, companyId), eq(modelDirectoryEntries.id, entryId)));
    if (!entry) throw notFound("Model setup not found");
    return entry;
  }

  const isLocalEntry = (e: { provider: string; baseUrl: string | null }) => e.provider === "local" && !!e.baseUrl?.trim();

  /** The Check button: probes now and stores the result. A hosted model has nothing to check. */
  async function checkEntry(companyId: string, entryId: string): Promise<ModelDirectoryEntryHealth> {
    const entry = await getEntry(companyId, entryId);
    if (!isLocalEntry(entry)) return { entryId, applicable: false, ...modelHealthReport("not_checked") };
    return { entryId, applicable: true, ...(await checkTarget(companyId, entry.baseUrl!, entry.model)) };
  }

  /** Stored state for every entry plus the agents that use a local model (for the agent-page banner). Reads only. */
  async function overview(companyId: string): Promise<ModelHealthOverview> {
    const entries = await db.select().from(modelDirectoryEntries).where(eq(modelDirectoryEntries.companyId, companyId));
    const states = await db.select().from(localModelHealth).where(eq(localModelHealth.companyId, companyId));
    const byKey = new Map(states.map((s) => [`${s.baseUrl}\n${s.model}`, s]));
    const entryHealth: ModelDirectoryEntryHealth[] = entries.map((e) => {
      if (!isLocalEntry(e)) return { entryId: e.id, applicable: false, ...modelHealthReport("not_checked") };
      return { entryId: e.id, applicable: true, ...reportOf(byKey.get(`${normalizeLocalModelAddress(e.baseUrl)}\n${e.model}`) ?? null, e.model) };
    });
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, provider: agents.laneAProvider, baseUrl: agents.laneABaseUrl, model: agents.laneAModel, entryId: agents.laneADirectoryEntryId })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.laneAEnabled, true), eq(agents.laneAProvider, "local")));
    const agentHealth: AgentModelHealth[] = agentRows
      .filter((a) => a.baseUrl?.trim() && a.model)
      .map((a) => {
        const report = reportOf(byKey.get(`${normalizeLocalModelAddress(a.baseUrl)}\n${a.model}`) ?? null, a.model!);
        return {
          agentId: a.id,
          agentName: a.name,
          entryId: a.entryId ?? null,
          ...report,
          showBanner: report.status === "unreachable" || report.status === "model_missing",
        };
      });
    return { entries: entryHealth, agents: agentHealth };
  }

  /**
   * Background pass: probes every distinct local model an agent is using right
   * now (company-wide, one probe per address+model however many agents share it).
   */
  async function checkInUse(): Promise<{ checked: number }> {
    const rows = await db
      .selectDistinct({ companyId: agents.companyId, baseUrl: agents.laneABaseUrl, model: agents.laneAModel })
      .from(agents)
      .where(and(eq(agents.laneAEnabled, true), eq(agents.laneAProvider, "local"), sql`${agents.status} <> 'terminated'`));
    let checked = 0;
    for (const r of rows) {
      if (!r.baseUrl?.trim() || !r.model) continue;
      await checkTarget(r.companyId, r.baseUrl, r.model);
      checked += 1;
    }
    return { checked };
  }

  /**
   * Evening-before warning: true at most once per outage (and not twice within
   * 18h) when this model has been down for the last hour. The caller sends the
   * words; this only decides, atomically.
   */
  async function claimEveningWarning(companyId: string, rawBaseUrl: string, model: string): Promise<boolean> {
    const now = nowOf();
    const claimed = await db
      .update(localModelHealth)
      .set({ eveningWarnedAt: now })
      .where(
        and(
          eq(localModelHealth.companyId, companyId),
          eq(localModelHealth.baseUrl, normalizeLocalModelAddress(rawBaseUrl)),
          eq(localModelHealth.model, model),
          sql`${localModelHealth.status} <> 'ready'`,
          lt(localModelHealth.outageStartedAt, new Date(now.getTime() - MODEL_OUTAGE_WARN_AFTER_MS)),
          or(isNull(localModelHealth.eveningWarnedAt), lt(localModelHealth.eveningWarnedAt, new Date(now.getTime() - MODEL_EVENING_WARNING_WINDOW_MS))),
        ),
      )
      .returning({ id: localModelHealth.id });
    return claimed.length > 0;
  }

  // ─── Test button ───────────────────────────────────────────────────────

  async function oneTestRun(baseUrl: string, model: string, thinking: ModelTestRun["thinking"]): Promise<ModelTestRun> {
    const started = Date.now();
    let firstWordMs: number | null = null;
    try {
      const body: Record<string, unknown> = {
        model,
        stream: true,
        max_tokens: 200,
        messages: [{ role: "user", content: MODEL_TEST_PROMPT }],
      };
      if (thinking === "off") body.reasoning_effort = "none";
      const res = await fetchImpl(`${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        return { thinking, ok: false, answer: null, firstWordMs: null, totalMs: Date.now() - started, error: `The model answered with an error (HTTP ${res.status}).` };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              if (firstWordMs === null) firstWordMs = Date.now() - started;
              answer += delta;
            }
          } catch {
            // A partial or non-JSON line: ignore it, the next one carries on.
          }
        }
      }
      const totalMs = Date.now() - started;
      if (answer.trim().length === 0) {
        return { thinking, ok: false, answer: null, firstWordMs: null, totalMs, error: "The model answered, but with no words." };
      }
      return { thinking, ok: true, answer: answer.trim(), firstWordMs, totalMs, error: null };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        thinking,
        ok: false,
        answer: null,
        firstWordMs,
        totalMs: Date.now() - started,
        error: timedOut ? "The model took too long to answer." : "Couldn't reach the model. Is your PC on, and is Ollama running?",
      };
    }
  }

  /**
   * The Test button. A setup that cannot be run at all gets a plain-English
   * reason and no call. A hosted model needs the agent's key, which the
   * directory never holds, so it is explained rather than attempted.
   */
  async function testEntry(companyId: string, entryId: string): Promise<ModelTestResult> {
    const entry = await getEntry(companyId, entryId);
    const base = { entryId, prompt: MODEL_TEST_PROMPT, runs: [] as ModelTestRun[] };
    const cannot = modelCannotRunReason(entry);
    if (cannot) return { ...base, ran: false, reason: cannot };
    if (!isLocalEntry(entry)) {
      return {
        ...base,
        ran: false,
        reason: "This model needs a key, and saved setups never hold one. Test it from an agent that uses it.",
      };
    }
    const modes: ModelTestRun["thinking"][] = laneAModelAcceptsReasoningEffort(entry.provider, entry.model) ? ["on", "off"] : ["default"];
    const runs: ModelTestRun[] = [];
    for (const mode of modes) runs.push(await oneTestRun(entry.baseUrl!, entry.model, mode));
    return { ...base, ran: true, reason: null, runs };
  }

  /** DUR-4557: the reviewer's probe set and host capability fetch for one saved setup (company-scoped lookup). */
  async function probeEntry(companyId: string, entryId: string) {
    return createModelSetupProbes(fetchImpl).runProbeSet(await getEntry(companyId, entryId));
  }
  async function capabilitiesForEntry(companyId: string, entryId: string, opts: { toolCount?: number | null; systemPromptChars?: number | null } = {}) {
    return createModelSetupProbes(fetchImpl).fetchHostCapabilities(await getEntry(companyId, entryId), opts);
  }

  return { probeEntry, capabilitiesForEntry, probe: (b: string, m: string) => probeLocalModel(b, m, fetchImpl), record, noteLocalAttempt, claimOutageNotice, claimEveningWarning, checkEntry, overview, checkInUse, testEntry };
}

const MODEL_UNAVAILABLE_PATTERN = /model[^.]*(not loaded|not found|does not exist|is not available|unknown)/i;

/**
 * Whether a failed attempt on a local model means the PC / Ollama is off
 * ("unreachable") or the model isn't installed ("model_missing"). Anything
 * else (a refusal, a bad request) says nothing about the PC and returns null.
 */
export function classifyLocalFailure(err: unknown): "unreachable" | "model_missing" | null {
  const e = err as { name?: string; kind?: string; message?: string } | null;
  if (!e || e.name !== "LaneAProviderError") return null;
  if (e.kind === "network") return "unreachable";
  if (e.kind === "upstream" && MODEL_UNAVAILABLE_PATTERN.test(e.message ?? "")) return "model_missing";
  return null;
}

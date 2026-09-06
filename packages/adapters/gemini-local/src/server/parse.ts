import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function collectMessageText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = parseObject(message);
  const direct = asString(record.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text, "").trim() || asString(part.content, "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.sessionID, "").trim() ||
    asString(event.checkpoint_id, "").trim() ||
    asString(event.thread_id, "").trim() ||
    null
  );
}

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function accumulateUsage(
  target: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageRaw: unknown,
) {
  const usage = parseObject(usageRaw);
  const usageMetadata = parseObject(usage.usageMetadata);
  const source = Object.keys(usageMetadata).length > 0 ? usageMetadata : usage;

  target.inputTokens += asNumber(
    source.input_tokens,
    asNumber(source.inputTokens, asNumber(source.promptTokenCount, 0)),
  );
  target.cachedInputTokens += asNumber(
    source.cached_input_tokens,
    asNumber(
      source.cachedInputTokens,
      asNumber(source.cachedContentTokenCount, asNumber(source.cached, 0)),
    ),
  );
  target.outputTokens += asNumber(
    source.output_tokens,
    asNumber(source.outputTokens, asNumber(source.candidatesTokenCount, 0)),
  );
}

/**
 * The Gemini CLI's own structured success/failure verdict for a terminal
 * "result" event. See DUR-258: this is the CLI's own verdict and must win
 * over any process-level signal (exit code) when a result event exists at
 * all — see how `execute.ts` uses this for the `failed` determination.
 */
export function isGeminiResultError(event: Record<string, unknown> | null | undefined): boolean {
  if (!event) return false;
  const status = asString(event.status, "").toLowerCase();
  return (
    event.is_error === true ||
    asString(event.subtype, "").toLowerCase() === "error" ||
    status === "error" ||
    status === "failed"
  );
}

export function parseGeminiJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  let question: { prompt: string; choices: Array<{ key: string; label: string; description?: string }> } | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const foundSessionId = readSessionId(event);
    if (foundSessionId) sessionId = foundSessionId;

    const type = asString(event.type, "").trim();

    if (type === "assistant") {
      messages.push(...collectMessageText(event.message));
      const messageObj = parseObject(event.message);
      const content = Array.isArray(messageObj.content) ? messageObj.content : [];
      for (const partRaw of content) {
        const part = parseObject(partRaw);
        if (asString(part.type, "").trim() === "question") {
          question = {
            prompt: asString(part.prompt, "").trim(),
            choices: (Array.isArray(part.choices) ? part.choices : []).map((choiceRaw) => {
              const choice = parseObject(choiceRaw);
              return {
                key: asString(choice.key, "").trim(),
                label: asString(choice.label, "").trim(),
                description: asString(choice.description, "").trim() || undefined,
              };
            }),
          };
          break; // only one question per message
        }
      }
      continue;
    }

    // Gemini CLI v0.38+ stream-json schema emits assistant turns as:
    // {"type":"message","role":"assistant","content":"...","delta":true}
    // These are discrete final messages (one per assistant turn), not
    // cumulative streaming tokens, so collecting all of them produces the
    // expected concatenated turn-by-turn summary rather than duplicated text.
    if (type === "message") {
      const role = asString(event.role, "").trim().toLowerCase();
      if (role === "assistant") {
        messages.push(...collectMessageText(event.content));
      }
      continue;
    }

    if (type === "result") {
      resultEvent = event;
      accumulateUsage(usage, event.usage ?? event.usageMetadata ?? event.stats);
      const resultText =
        asString(event.result, "").trim() ||
        asString(event.text, "").trim() ||
        asString(event.response, "").trim();
      if (resultText && messages.length === 0) messages.push(resultText);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      const isError = isGeminiResultError(event);
      if (isError) {
        const text = asErrorText(event.error ?? event.message ?? event.result).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "error") {
      const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
      if (text) errorMessage = text;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event.subtype, "").trim().toLowerCase();
      if (subtype === "error") {
        const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish" || event.usage || event.usageMetadata) {
      accumulateUsage(usage, event.usage ?? event.usageMetadata);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage,
    resultEvent,
    question,
  };
}

// DUR-258: word-search only runs over `stderr` (a crashed/rejected
// process's own short error text) and the CLI's own structured error
// fields — never over `stdout`. In stream-json mode, stdout is the full
// multi-turn transcript, and an agent merely *discussing* a session/auth
// topic (e.g. while testing session-resume error handling) was enough to
// mislabel a successful or unrelated-failure run.
export function isGeminiSessionUnrecoverableError(errorText: string, stderr: string): boolean {
  const haystack = `${errorText}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|checkpoint\s+.*\s+not\s+found|cannot\s+resume|failed\s+to\s+resume|exceeds\s+the\s+maximum\s+number\s+of\s+tokens|input\s+token\s+count\s+exceeds/i.test(
    haystack,
  );
}

export function isGeminiTransientNetworkError(errorText: string, stderr: string): boolean {
  const haystack = `${errorText}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /ENOTFOUND\s+oauth2\.googleapis\.com|ENOTFOUND\s+sts\.googleapis\.com|EAI_AGAIN|_GaxiosError.*ENOTFOUND|_UserRefreshClient.*ENOTFOUND/i.test(
    haystack,
  );
}

function extractGeminiErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const errorMsg = asString(parsed.error, "").trim();
  if (errorMsg) messages.push(errorMsg);

  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }
    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function describeGeminiFailure(parsed: Record<string, unknown>): string | null {
  const status = asString(parsed.status, "");
  const errors = extractGeminiErrorMessages(parsed);

  const detail = errors[0] ?? "";
  const parts = ["Gemini run failed"];
  if (status) parts.push(`status=${status}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

// "unauthorized" alone is deliberately excluded: a run's own tool output can
// legitimately echo an unrelated 401 response (e.g. while testing an API),
// so a bare "unauthorized" substring is not reliable evidence of a real
// logout. Only count it when paired with something that actually points at
// the login flow. See DUR-258 — this used to match "unauthorized" alone.
const GEMINI_AUTH_REQUIRED_RE =
  /(?:not\s+authenticated|please\s+authenticate|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|manual\s+authorization\s+is\s+required|invalid\s+credentials|not\s+logged\s+in|login\s+required|run\s+`?gemini\s+auth(?:\s+login)?`?\s+first|unauthorized[\s\S]{0,120}(?:log\s?in|authenticate))/i;
const GEMINI_QUOTA_EXHAUSTED_RE =
  /(?:resource_exhausted|quota|rate[-\s]?limit|too many requests|\b429\b|billing details)/i;

// DUR-258: word-search only runs over the CLI's own extracted error
// messages plus `stderr` (a crashed/rejected process's own short error
// text) — never over `stdout`. In stream-json mode, stdout is the full
// multi-turn transcript, and an agent merely *discussing* an auth/quota
// topic (e.g. while hardening our own auth code) was enough to mislabel a
// successful or unrelated-failure run as a real logout or quota stop.
export function detectGeminiAuthRequired(input: {
  parsed: Record<string, unknown> | null;
  stderr: string;
}): { requiresAuth: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresAuth = messages.some((line) => GEMINI_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}

export function detectGeminiQuotaExhausted(input: {
  parsed: Record<string, unknown> | null;
  stderr: string;
}): { exhausted: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const exhausted = messages.some((line) => GEMINI_QUOTA_EXHAUSTED_RE.test(line));
  return { exhausted };
}

export function isGeminiTurnLimitResult(
  parsed: Record<string, unknown> | null | undefined,
  exitCode?: number | null,
): boolean {
  if (exitCode === 53) return true;
  if (!parsed) return false;

  const structuredStopReasons = [
    parsed.status,
    parsed.stopReason,
    parsed.stop_reason,
    parsed.errorCode,
    parsed.error_code,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "turn_limit" ||
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit_exhausted",
  );
}

import { redactCommandText } from "@paperclipai/adapter-utils";
import { isLuhnValid } from "@paperclipai/adapter-utils/payment-detection";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring|card[-_]?number|card[-_]?cvc|cvc|cvv)[A-Za-z0-9_-]*`;

// Exported so callers outside this module (e.g. the DUR-132 mcpServers
// credential-shaped-literal-value advisory in server/src/routes/agents.ts)
// can reuse the exact same "does this field name look like a secret" rule
// instead of re-declaring a copy that could drift out of sync.
export const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  // DUR-370: fine-grained GitHub PATs (`github_pat_<id>_<secret>`) contain none
  // of the hints above, so a line carrying only that token (and no ".") would
  // skip redactSensitiveText entirely. The matching regex lives in
  // adapter-utils command-redaction.ts; this hint just lets it run.
  "github_pat_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

export function redactSensitiveText(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    input
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  );
}

// DUR-132: literal-value redaction for credentials that don't have a known
// process-env variable NAME to key off (e.g. a resolved mcpServers secret_ref
// -- see resolveMcpServersForRuntime in server/src/services/secrets.ts). Only
// values of a reasonable minimum length are scrubbed; shorter strings risk
// mangling unrelated output and are unlikely to be meaningful credentials.
export function redactKnownSecretValues(input: string, secretValues: Iterable<string>): string {
  let output = input;
  for (const value of secretValues) {
    if (!value || value.length < 6) continue;
    output = output.split(value).join(REDACTED_EVENT_VALUE);
  }
  return output;
}

// DUR-292 item 2 (DUR-317): fixed-shape secret patterns that leak into agent
// output/adapter results without ever being registered as a known Secret --
// e.g. NOR-316's GitHub PAT sitting in a git remote URL. This is the same
// pattern list as DUR-316's periodic scanner (item 1); keep the two in sync.
// Each match is tagged with the pattern name (not just REDACTED_EVENT_VALUE)
// so the surrounding log context stays useful for debugging which credential
// kind leaked.
export interface SecretLeakPattern {
  readonly name: string;
  readonly regex: RegExp;
}

export const SECRET_LEAK_PATTERNS: readonly SecretLeakPattern[] = [
  { name: "github_pat", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "github_token", regex: /ghp_[A-Za-z0-9]{20,}/g },
  // DUR-322 follow-up: gho_/ghu_/ghs_/ghr_ were already tracked as sensitive
  // by SECRET_TEXT_HINTS above but missing here -- e.g. a `git clone
  // https://x-access-token:ghs_XXXX@github.com/...` failure dumps a live
  // GitHub App installation token to stderr unmasked without these.
  { name: "github_oauth_token", regex: /gho_[A-Za-z0-9]{20,}/g },
  { name: "github_user_token", regex: /ghu_[A-Za-z0-9]{20,}/g },
  { name: "github_app_installation_token", regex: /ghs_[A-Za-z0-9]{20,}/g },
  { name: "github_refresh_token", regex: /ghr_[A-Za-z0-9]{20,}/g },
  // DUR-1430: DUR-954 found this unanchored regex matching "sk-notification"
  // inside the unrelated JSON value "task-notification" (the "sk-" fell
  // mid-word, right after "ta"). \b requires a non-word/word transition
  // immediately before "sk-", which real keys always have (quote, `=`,
  // whitespace, or string start) and "task-notification" does not (the
  // preceding "a" is a word character too).
  { name: "openai_key", regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { name: "shopify_shared_secret", regex: /shpss_[A-Za-z0-9]{20,}/g },
  { name: "shopify_access_token", regex: /shpat_[A-Za-z0-9]{20,}/g },
  { name: "slack_bot_token", regex: /xoxb-[A-Za-z0-9-]{10,}/g },
  // DUR-322 follow-up: xoxp- (Slack user token, scoped to a human's full
  // permissions) is arguably the most sensitive Slack token variant and was
  // missing from the initial pattern set.
  { name: "slack_user_token", regex: /xoxp-[A-Za-z0-9-]{10,}/g },
  { name: "aws_access_key_id", regex: /AKIA[A-Z0-9]{12,}/g },
  // Known limitation (flagged in DUR-322 review): this only matches the AWS
  // access key ID (the public half of the pair). The paired secret access
  // key has no fixed prefix/shape, so it cannot be pattern-matched here --
  // if an agent echoes both halves (e.g. dumping a .env on error), only the
  // access key ID gets redacted.
  {
    name: "pem_private_key",
    regex: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g,
  },
];

// DUR-4040: a card-shaped digit run (13-19 digits, Luhn-valid) redacted by
// VALUE, not by field name -- unlike SECRET_LEAK_PATTERNS above this has no
// fixed prefix to anchor on, so it is the one line of defense for a PAN that
// leaks somewhere with no "cardNumber"-shaped key nearby (a run transcript
// quoting a page's own text, a stray HTTP response body). Reuses the exact
// Luhn check `browser_type`'s payment-detection refusal already relies on
// (packages/adapter-utils/src/payment-detection.ts) instead of a second copy
// that could drift out of sync with what that gate considers a card number.
// Same "card-number-shaped" token pattern as findLuhnValidRuns in
// payment-detection.ts (digits with optional single spaces/dashes between
// groups), kept in sync deliberately -- that module only returns the
// digits-only matches (it just needs to know whether any exist), which is not
// enough to replace the ORIGINAL spaced/dashed substring in place here.
const CARD_NUMBER_TOKEN_RE = /\d(?:[\s-]?\d){11,18}/g;

// DUR-4534/DUR-4535/DUR-4536: an earlier version of this function tried to
// tell a genuinely-incidental UUID digit coincidence apart from a card
// number smuggled by dressing it up as a UUID, using heuristics about which
// characters bound the matched digit run (span-interior vs span-edge,
// truncated-by-the-19-digit-cap vs not). Every version of that heuristic was
// defeated by a new input shape, because the string is attacker-controlled
// end to end -- there is no character-shape rule that distinguishes "a real
// random UUID whose digits coincidentally look like a card number" from "a
// crafted UUID-shaped string built around a real card number", since both
// are, by construction, indistinguishable sequences of hex digits and
// dashes. So this function no longer tries: it always redacts a Luhn-valid
// card-shaped digit run, even when it sits inside something that looks like
// a UUID. The real fix for the original DUR-4534 complaint (genuine
// server-generated UUIDs getting corrupted) lives at the call site instead:
// redactKnownLeakedSecretPatternsDeep skips this scrub for a short,
// hardcoded allowlist of exact field paths that are known to hold
// DB-generated UUIDs the agent/attacker never controls the content of (see
// ID_PATHS_SKIP_CARD_REDACTION below) -- not for anything shaped like a UUID.
export function redactCardNumbers(input: string): string {
  if (!input) return input;
  return input.replace(CARD_NUMBER_TOKEN_RE, (match) => {
    const digitsOnly = match.replace(/[\s-]/g, "");
    if (digitsOnly.length < 13 || digitsOnly.length > 19) return match;
    return isLuhnValid(digitsOnly) ? "[REDACTED:card_number]" : match;
  });
}

export function redactKnownLeakedSecretPatterns(input: string): string {
  if (!input) return input;
  let output = input;
  for (const pattern of SECRET_LEAK_PATTERNS) {
    output = output.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }
  return redactCardNumbers(output);
}

const UUID_WHOLE_STRING_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DUR-4534/4536/4538/4540-SR2: the original bug report was that a
// server-generated UUID (e.g. an issueId) can, by Luhn coincidence, read as a
// card number and get mangled by redactCardNumbers before it reaches
// resultJson. An exact dotted-path allowlist (checked below) replaced the
// defeatable character-shape heuristic, but the DUR-4540 security re-review
// found that path alone is not a trust signal: server/src/services/
// heartbeat.ts spreads `parseObject(adapterResult.resultJson)` -- parsed
// from agent/adapter-controlled output -- directly into the object this
// function walks, so an agent can forge e.g.
// `{"workspaceValidation":{"issueId":"<uuid-shaped-PAN>"}}` in its own result
// JSON and land on an allowlisted path with nobody having checked where that
// path's *content* actually came from. The same applies to any other caller
// of the exported, no-allowlist `redactKnownLeakedSecretPatternsDeep` below
// if it is ever handed attacker-shaped JSON with a colliding key layout.
//
// Fix: the ID_PATHS allowlist is no longer reachable from the general
// `redactKnownLeakedSecretPatternsDeep` export (data-read-audit.ts,
// workspace-operations.ts, and any future caller of that export always get
// the full, unconditional scrub -- no exemption, no matter what shape the
// caller's JSON has). It is only consulted via the `useIdAllowlist` flag
// that `redactHeartbeatRunPatchSecrets` passes -- and only *after* that
// function has stripped the two keys the one reachable attacker surface
// (the adapterResult.resultJson spread) could use to forge a path collision
// (`workspaceValidation`, `interruptedIssueId`). With both of those keys
// guaranteed absent from attacker-controlled input by the time the
// allowlist runs, a path match can only originate from the trusted
// heartbeat.ts/operatorInterruptCancelOptions construction sites that
// populate these fields from DB rows or a board-only-gated request.
const ID_PATHS_SKIP_CARD_REDACTION = new Set([
  "workspaceValidation.issueId",
  "workspaceValidation.issueProjectId",
  "workspaceValidation.issueProjectWorkspaceId",
  "workspaceValidation.resolvedProjectId",
  "workspaceValidation.resolvedProjectWorkspaceId",
  "workspaceValidation.executionWorkspaceProjectId",
  "workspaceValidation.executionWorkspaceProjectWorkspaceId",
  "workspaceValidation.persistedExecutionWorkspaceId",
  "workspaceValidation.persistedProjectId",
  "workspaceValidation.persistedProjectWorkspaceId",
  "interruptedIssueId",
]);

// The top-level keys the ID allowlist above protects that are reachable
// through attacker/agent-controlled input (see the comment above):
// `workspaceValidation` and `interruptedIssueId`, both via the
// adapterResult.resultJson spread in heartbeat.ts (an agent's own result
// JSON can declare either key at the top level). That call site -- and only
// that call site -- strips these keys from the agent-controlled object it is
// about to spread, using this helper, *before* merging in whatever the
// server itself wants to set for this run. This function is NOT called
// generically on every resultJson here, because the legitimate
// workspaceValidation object (the one this allowlist exists to protect,
// e.g. the original DUR-4534 case) also flows through this same patch shape
// on the workspace-validation-failure path, and unconditionally stripping
// the key there would silently delete the real data this allowlist is
// supposed to preserve.
export function stripAgentControlledIdAllowlistKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "workspaceValidation" || key === "interruptedIssueId") continue;
    out[key] = entry;
  }
  return out;
}

function redactDeep(value: unknown, path: string, useIdAllowlist: boolean): unknown {
  if (typeof value === "string") {
    if (useIdAllowlist && ID_PATHS_SKIP_CARD_REDACTION.has(path) && UUID_WHOLE_STRING_RE.test(value)) {
      // Still run the non-card secret patterns (API keys, tokens, etc.) --
      // only the card-number scrub is skipped for this known-safe path.
      let output = value;
      for (const pattern of SECRET_LEAK_PATTERNS) {
        output = output.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
      }
      return output;
    }
    return redactKnownLeakedSecretPatterns(value);
  }
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, path, useIdAllowlist));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactDeep(entry, path ? `${path}.${key}` : key, useIdAllowlist);
    }
    return out;
  }
  return value;
}

// Exported (DUR-372) so callers with their own JSON-shaped value to scrub --
// e.g. workspace_operations.metadata in workspace-operations.ts -- can reuse
// the identical deep-walk instead of only having access to the
// heartbeat_runs-shaped redactHeartbeatRunPatchSecrets below. Deliberately
// has NO id-path allowlist (see DUR-4540 comment above): every caller of
// this export gets the unconditional card scrub, because this function has
// no way to know whether its caller's JSON shape is attacker-influenced.
export function redactKnownLeakedSecretPatternsDeep(value: unknown): unknown {
  return redactDeep(value, "", false);
}

// Write-time gate for heartbeat_runs: applied to the patch object right
// before it reaches the DB update/insert (see setRunStatus/setRunStatusIfRunning
// in server/src/services/heartbeat.ts) so a leaked credential is masked
// before the row is ever committed, not scanned after the fact.
export function redactHeartbeatRunPatchSecrets<T extends Record<string, unknown>>(patch: T): T {
  const next: Record<string, unknown> = { ...patch };
  if (typeof next.error === "string") {
    next.error = redactKnownLeakedSecretPatterns(next.error);
  }
  if (typeof next.stdoutExcerpt === "string") {
    next.stdoutExcerpt = redactKnownLeakedSecretPatterns(next.stdoutExcerpt);
  }
  if (typeof next.stderrExcerpt === "string") {
    next.stderrExcerpt = redactKnownLeakedSecretPatterns(next.stderrExcerpt);
  }
  if (isPlainObject(next.resultJson)) {
    // The id-path allowlist below is only safe to apply here because the one
    // reachable attacker surface for this patch shape -- the
    // adapterResult.resultJson spread in heartbeat.ts -- has already had its
    // `workspaceValidation` key stripped via stripAgentControlledIdAllowlistKeys
    // before this function is ever called (see DUR-4540 comment above
    // ID_PATHS_SKIP_CARD_REDACTION). Any `workspaceValidation` that does
    // reach this point was built by the server itself.
    next.resultJson = redactDeep(next.resultJson, "", true);
  }
  return next as T;
}

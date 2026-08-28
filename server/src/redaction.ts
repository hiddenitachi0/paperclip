import { redactCommandText } from "@paperclipai/adapter-utils";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

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
  { name: "openai_key", regex: /sk-[A-Za-z0-9_-]{12,}/g },
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

export function redactKnownLeakedSecretPatterns(input: string): string {
  if (!input) return input;
  let output = input;
  for (const pattern of SECRET_LEAK_PATTERNS) {
    output = output.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }
  return output;
}

function redactKnownLeakedSecretPatternsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactKnownLeakedSecretPatterns(value);
  if (Array.isArray(value)) return value.map(redactKnownLeakedSecretPatternsDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactKnownLeakedSecretPatternsDeep(entry);
    }
    return out;
  }
  return value;
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
    next.resultJson = redactKnownLeakedSecretPatternsDeep(next.resultJson);
  }
  return next as T;
}

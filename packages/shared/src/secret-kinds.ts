/**
 * What a stored secret IS.
 *
 * Until now a company secret was a name, a key and an encrypted value, and
 * nothing in Paperclip knew whether the value was an OpenAI key, a Fiken
 * token or a GitHub token. That is why no screen could offer "the right
 * tokens for the provider you just picked", and why nothing could check a
 * pasted key on the spot.
 *
 * This module is the one list of kinds. It is deliberately small and plain:
 * an id that goes in `company_secrets.kind`, a label a non-technical owner
 * understands, the provider it belongs to, a category for grouping in a
 * dropdown, a loose value-shape check, and the environment variable name a
 * CLI agent would read the value as (where one exists).
 *
 * Adding a kind here is additive. Nothing consumes a kind it does not know,
 * and a secret with no kind keeps behaving exactly as before.
 */

/** Who issued the credential. */
export type SecretKindProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "local"
  | "github"
  | "shopify"
  | "fiken"
  | "telegram"
  | "slack"
  | "other";

/** How the Secrets screens group kinds. */
export type SecretKindCategory = "ai_provider" | "data_source" | "vcs" | "messaging" | "other";

export interface SecretKindDescriptor {
  /** Stored in company_secrets.kind. Stable; never rename. */
  id: SecretKind;
  /** Plain words for the dropdown and the list, e.g. "OpenAI API key". */
  label: string;
  /** One short sentence about what the credential is for. */
  description: string;
  provider: SecretKindProvider;
  category: SecretKindCategory;
  /**
   * Loose shape check for the pasted value, used only to warn "that does not
   * look like a … key" before saving. Never a hard rule: providers change
   * their formats, and a wrong warning is worse than none.
   */
  valuePattern?: RegExp;
  /**
   * The environment variable a CLI adapter (Claude Code, Codex, Gemini CLI…)
   * reads this value as. Present only where a well-known name exists. Also
   * what the migration backfill uses to give existing secrets a kind.
   */
  envKey?: string;
  /**
   * True when Paperclip can check the value with one harmless call to the
   * provider (the Test button). Only AI-provider API keys today.
   */
  testable: boolean;
}

export const SECRET_KIND_IDS = [
  "anthropic_api_key",
  "claude_subscription_token",
  "openai_api_key",
  "google_api_key",
  "openrouter_api_key",
  "local_model_endpoint",
  "github_token",
  "shopify_admin_token",
  "fiken_api_token",
  "telegram_bot_token",
  "slack_bot_token",
  "other",
] as const;

export type SecretKind = (typeof SECRET_KIND_IDS)[number];

/** Plain labels for the category headings in a grouped dropdown. */
export const SECRET_KIND_CATEGORY_LABELS: Record<SecretKindCategory, string> = {
  ai_provider: "AI providers",
  data_source: "Data sources",
  vcs: "Code hosting",
  messaging: "Messaging",
  other: "Other",
};

/** Display order for categories. */
export const SECRET_KIND_CATEGORY_ORDER: readonly SecretKindCategory[] = [
  "ai_provider",
  "data_source",
  "vcs",
  "messaging",
  "other",
];

export const SECRET_KINDS: readonly SecretKindDescriptor[] = [
  {
    id: "anthropic_api_key",
    label: "Claude API key",
    description: "Pay-as-you-go key for Claude models from console.anthropic.com.",
    provider: "anthropic",
    category: "ai_provider",
    valuePattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    envKey: "ANTHROPIC_API_KEY",
    testable: true,
  },
  {
    id: "claude_subscription_token",
    label: "Claude subscription sign-in",
    description: "Sign-in token from `claude setup-token`, for agents billed to a Claude subscription.",
    provider: "anthropic",
    category: "ai_provider",
    envKey: "CLAUDE_CODE_OAUTH_TOKEN",
    testable: false,
  },
  {
    id: "openai_api_key",
    label: "OpenAI API key",
    description: "Key for GPT models from platform.openai.com.",
    provider: "openai",
    category: "ai_provider",
    valuePattern: /^sk-[A-Za-z0-9_-]{20,}$/,
    envKey: "OPENAI_API_KEY",
    testable: true,
  },
  {
    id: "google_api_key",
    label: "Google Gemini API key",
    description: "Key for Gemini models from aistudio.google.com.",
    provider: "google",
    category: "ai_provider",
    valuePattern: /^AIza[A-Za-z0-9_-]{20,}$/,
    envKey: "GEMINI_API_KEY",
    testable: true,
  },
  {
    id: "openrouter_api_key",
    label: "OpenRouter API key",
    description: "Key from openrouter.ai, which gives access to many models through one account.",
    provider: "openrouter",
    category: "ai_provider",
    valuePattern: /^sk-or-[A-Za-z0-9_-]{20,}$/,
    envKey: "OPENROUTER_API_KEY",
    testable: true,
  },
  {
    id: "local_model_endpoint",
    label: "Local model server",
    description:
      "Address of an OpenAI-compatible model server you run yourself (Ollama, LM Studio, vLLM), " +
      "optionally followed by a space and its key.",
    provider: "local",
    category: "ai_provider",
    valuePattern: /^https?:\/\/\S+/,
    testable: true,
  },
  {
    id: "github_token",
    label: "GitHub token",
    description: "Personal access token for cloning, pushing and opening pull requests.",
    provider: "github",
    category: "vcs",
    valuePattern: /^(ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]{20,}$/,
    envKey: "GITHUB_TOKEN",
    testable: false,
  },
  {
    id: "shopify_admin_token",
    label: "Shopify admin token",
    description: "Read-only Admin API token for a Shopify store, used by the Shopify data source.",
    provider: "shopify",
    category: "data_source",
    valuePattern: /^shpat_[A-Za-z0-9]{16,}$/,
    testable: false,
  },
  {
    id: "fiken_api_token",
    label: "Fiken API token",
    description: "Token for the Fiken accounting API, used by the Fiken data source.",
    provider: "fiken",
    category: "data_source",
    testable: false,
  },
  {
    id: "telegram_bot_token",
    label: "Telegram bot token",
    description: "Token from BotFather for a Telegram bot that talks to one agent.",
    provider: "telegram",
    category: "messaging",
    valuePattern: /^\d{6,}:[A-Za-z0-9_-]{20,}$/,
    testable: false,
  },
  {
    id: "slack_bot_token",
    label: "Slack bot token",
    description: "Bot token (xoxb-…) for posting to Slack.",
    provider: "slack",
    category: "messaging",
    valuePattern: /^xox[abp]-[A-Za-z0-9-]{10,}$/,
    envKey: "SLACK_BOT_TOKEN",
    testable: false,
  },
  {
    id: "other",
    label: "Something else",
    description: "Any other password or token. Paperclip stores it but cannot test it.",
    provider: "other",
    category: "other",
    testable: false,
  },
] as const;

const byId = new Map<string, SecretKindDescriptor>(SECRET_KINDS.map((kind) => [kind.id, kind]));

/**
 * Env var name -> kind. GH_TOKEN is the gh CLI's alias for GITHUB_TOKEN and
 * PAPERCLIP_GITHUB_TOKEN the by-name fallback the GitHub provider checks, so
 * all three are the same kind of token.
 */
const byEnvKey = new Map<string, SecretKind>([
  ...SECRET_KINDS.filter((kind) => kind.envKey).map((kind) => [kind.envKey as string, kind.id] as const),
  ["GH_TOKEN", "github_token"],
  ["PAPERCLIP_GITHUB_TOKEN", "github_token"],
  ["GOOGLE_API_KEY", "google_api_key"],
]);

export function isSecretKind(value: unknown): value is SecretKind {
  return typeof value === "string" && byId.has(value);
}

export function getSecretKind(id: string | null | undefined): SecretKindDescriptor | undefined {
  return id ? byId.get(id) : undefined;
}

/** Plain label for a kind, or null when the secret has no (known) kind. */
export function secretKindLabel(id: string | null | undefined): string | null {
  return getSecretKind(id)?.label ?? null;
}

/**
 * Best-effort kind for an env var name such as ANTHROPIC_API_KEY. Matching is
 * exact on the upper-cased name, so a secret whose key was derived from an
 * env var by the Add-integration-token dialog (e.g. `openai_api_key__all_agents`)
 * is also recognised by its prefix.
 */
export function secretKindForEnvKey(envKey: string | null | undefined): SecretKind | null {
  if (!envKey) return null;
  const upper = envKey.trim().toUpperCase();
  const exact = byEnvKey.get(upper);
  if (exact) return exact;
  const prefixEnd = upper.indexOf("__");
  if (prefixEnd > 0) return byEnvKey.get(upper.slice(0, prefixEnd)) ?? null;
  return null;
}

/** Every (env var name, kind) pair the backfill and the dropdown agree on. */
export function secretKindEnvKeyPairs(): ReadonlyArray<readonly [string, SecretKind]> {
  return [...byEnvKey.entries()].map(([envKey, kind]) => [envKey, kind] as const);
}

export function isTestableSecretKind(id: string | null | undefined): boolean {
  return getSecretKind(id)?.testable ?? false;
}

/** Kinds grouped for a dropdown, in display order, empty categories left out. */
export function secretKindsByCategory(): ReadonlyArray<{
  category: SecretKindCategory;
  label: string;
  kinds: readonly SecretKindDescriptor[];
}> {
  return SECRET_KIND_CATEGORY_ORDER.map((category) => ({
    category,
    label: SECRET_KIND_CATEGORY_LABELS[category],
    kinds: SECRET_KINDS.filter((kind) => kind.category === category),
  })).filter((group) => group.kinds.length > 0);
}

/**
 * True when a pasted value does not match the kind's loose shape. Only ever a
 * warning; kinds without a pattern never warn.
 */
export function secretValueLooksWrongForKind(id: string | null | undefined, value: string): boolean {
  const kind = getSecretKind(id);
  if (!kind?.valuePattern) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return !kind.valuePattern.test(trimmed);
}

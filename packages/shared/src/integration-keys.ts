/**
 * Canonical catalog of well-known integration environment-variable keys.
 *
 * A single source of truth for the env-var names that Paperclip (and common
 * agent tools) recognize, so the Secrets UI can offer a "pick a known token"
 * dropdown instead of making a non-expert type/guess the exact key name, and so
 * server-side consumers (git push/PR workflow, GitHub object provider) don't
 * drift from separate hard-coded lists.
 *
 * Adding an entry here surfaces it in the "Add integration token" dropdown; it
 * does NOT by itself make anything consume the value — the consuming code (an
 * agent's shell, an adapter, a built-in workflow) still reads the env var by
 * name at runtime.
 */

export type IntegrationKeyCategory = "vcs" | "llm" | "chat" | "other";

export interface IntegrationKeyDescriptor {
  /** Canonical env var name the agent sees, e.g. "GITHUB_TOKEN". */
  key: string;
  /** Short human label for the dropdown. */
  label: string;
  /** One-line explanation of what the token is for. */
  description: string;
  category: IntegrationKeyCategory;
  /**
   * Recognized by Paperclip's built-in git push / PR-open workflow. Surfacing
   * this lets the UI hint "this is the key git uses".
   */
  gitPush?: boolean;
  /**
   * Alternate/legacy secret NAMES that resolve to the same capability when
   * looked up by name (used by server-side by-name resolution fallbacks).
   */
  secretNameHints?: readonly string[];
}

export const KNOWN_INTEGRATION_ENV_KEYS: readonly IntegrationKeyDescriptor[] = [
  {
    key: "GITHUB_TOKEN",
    label: "GitHub token",
    description:
      "Clone/push GitHub repos and open PRs. Needs write access (repo / Contents: Read+Write) for pushing.",
    category: "vcs",
    gitPush: true,
    secretNameHints: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
  },
  {
    key: "GH_TOKEN",
    label: "GitHub token (gh CLI)",
    description: "Alternate GitHub token variable read by the gh CLI and some tooling.",
    category: "vcs",
    gitPush: true,
    secretNameHints: ["GH_TOKEN", "GITHUB_TOKEN"],
  },
  {
    key: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude subscription token",
    description:
      "OAuth token for Claude Code subscription billing (the claude_local adapter). From `claude setup-token`.",
    category: "llm",
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    description: "API key for Claude models via the metered Anthropic API.",
    category: "llm",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API key",
    description: "API key for OpenAI / GPT models.",
    category: "llm",
  },
  {
    key: "GEMINI_API_KEY",
    label: "Google Gemini API key",
    description: "API key for Google Gemini models.",
    category: "llm",
  },
  {
    key: "SLACK_BOT_TOKEN",
    label: "Slack bot token",
    description: "Bot token (xoxb-…) for posting to Slack.",
    category: "chat",
  },
] as const;

const byKey = new Map(KNOWN_INTEGRATION_ENV_KEYS.map((entry) => [entry.key, entry]));

export function getIntegrationKey(key: string): IntegrationKeyDescriptor | undefined {
  return byKey.get(key);
}

/**
 * Secret NAMES, in priority order, that a by-name GitHub-token lookup checks.
 * Derived from the catalog so there is one source of truth for "which secret is
 * the GitHub token". Consumed by the GitHub external-object provider and the
 * managed-workspace clone auth.
 */
export const GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/**
 * Env var names, in priority order, that grant git push capability. Consumed by
 * the heartbeat push-capability preflight. Kept aligned with the catalog's
 * `gitPush` entries.
 */
export const PUSH_CAPABILITY_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * DUR-3969 / DUR-3970 — where a Claude agent's sign-in comes from, and what to
 * tell the operator when it does not work.
 *
 * THE RESOLUTION ORDER (this is the whole contract; keep it in one place)
 * ----------------------------------------------------------------------
 *   1. "agent"       — the run's own merged environment already carries a
 *                      Claude credential. That merge covers every explicit
 *                      binding the operator can make: the agent's own
 *                      adapter_config.env, plus the environment, project and
 *                      routine env that were merged into it before we look.
 *                      An explicit binding ALWAYS wins, so an agent that must
 *                      use a different account (a client-owned subscription, a
 *                      separate quota) keeps behaving exactly as it did before
 *                      inheritance existed.
 *   2. "instance"    — nothing of its own, so the agent INHERITS the one
 *                      instance-wide Claude sign-in (Settings > Instance
 *                      settings > Claude sign-in). This is why employing an
 *                      agent needs no credential wiring at all, and why
 *                      renewing that one sign-in fixes every inheriting agent
 *                      at once without touching any of them.
 *   3. "process_env" — no instance sign-in either, but the server process
 *                      itself was started with a Claude token in its
 *                      environment. The adapter spawns the CLI with
 *                      `{ ...process.env, ...runEnv }`, so that token is what
 *                      the run would actually use. Named explicitly so the
 *                      operator message can be honest about it.
 *   4. "none"        — there is no Claude sign-in anywhere. The run will fail;
 *                      the operator is told once, at instance level, with the
 *                      one place to fix it.
 *
 * Nothing here touches the database or spawns anything: it is pure so the
 * order and the operator wording can be tested directly.
 */

/** Where the Claude credential for a run came from. */
export type ClaudeCredentialSource = "agent" | "instance" | "process_env" | "none";

/**
 * The env key an instance-wide (or server-process) Claude sign-in is injected
 * under. Kept here rather than in instance-claude-auth.ts so this module has
 * no dependency on the service; instance-claude-auth.ts re-exports it.
 */
export const CLAUDE_AUTH_FALLBACK_ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/** Where a non-technical operator goes to fix any of this. One place, always. */
export const CLAUDE_AUTH_SETTINGS_PATH = "Settings > Instance settings > Claude sign-in";

function hasNonEmptyEnvString(env: Record<string, unknown>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Mirrors the claude_local adapter's own auth detection: a subscription
 * token, an API key, or a Bedrock setup each count as "has its own way in".
 */
export function claudeEnvHasOwnCredential(env: Record<string, unknown>): boolean {
  if (hasNonEmptyEnvString(env, CLAUDE_AUTH_FALLBACK_ENV_KEY)) return true;
  if (hasNonEmptyEnvString(env, "ANTHROPIC_API_KEY")) return true;
  if (hasNonEmptyEnvString(env, "ANTHROPIC_AUTH_TOKEN")) return true;
  const bedrock = env.CLAUDE_CODE_USE_BEDROCK;
  if (bedrock === "1" || bedrock === "true" || bedrock === true) return true;
  if (hasNonEmptyEnvString(env, "ANTHROPIC_BEDROCK_BASE_URL")) return true;
  return false;
}

/**
 * Step 3 of the order above, kept separate so the caller can decide whether to
 * even look (only claude_local runs care).
 */
export function processEnvHasClaudeCredential(processEnv: NodeJS.ProcessEnv = process.env): boolean {
  return claudeEnvHasOwnCredential(processEnv as Record<string, unknown>);
}

/**
 * Classify a run whose merged env has already been resolved. `instanceToken`
 * is the token the instance sign-in handed over for this run (null when there
 * is no sign-in saved, or it could not be read).
 */
export function classifyClaudeCredentialSource(input: {
  mergedEnvHasOwnCredential: boolean;
  instanceToken: string | null;
  processEnv?: NodeJS.ProcessEnv;
}): ClaudeCredentialSource {
  if (input.mergedEnvHasOwnCredential) return "agent";
  if (input.instanceToken && input.instanceToken.trim().length > 0) return "instance";
  if (processEnvHasClaudeCredential(input.processEnv ?? process.env)) return "process_env";
  return "none";
}

/**
 * Whether a failure from this source is an INSTANCE fact (shared sign-in is
 * expired/rejected/absent) rather than an AGENT fact (this one agent's own
 * credential was turned down). Instance facts are reported once, at instance
 * level — never once per agent.
 */
export function claudeAuthFailureIsInstanceWide(source: ClaudeCredentialSource): boolean {
  return source !== "agent";
}

/**
 * The plain-language sentence a non-technical operator reads instead of
 * "Claude run failed: subtype=success: Not logged in - Please run /login" —
 * which describes the wrong problem (the instance is not signed out) and names
 * an action the operator cannot take (there is no prompt to type /login into).
 *
 * Each case says which of the three situations it is and where to fix it.
 */
export function buildClaudeAuthOperatorMessage(input: {
  source: ClaudeCredentialSource;
  agentName?: string | null;
}): string {
  const named = input.agentName?.trim() ?? "";
  /** Sentence-initial form. */
  const Who = named || "This agent";
  /** Mid-sentence form. */
  const who = named || "this agent";
  switch (input.source) {
    case "agent":
      return (
        `${Who} has its own Claude sign-in, and Claude turned that one down. ` +
        `Give it a new Claude token of its own, or take the old one away so it shares the ` +
        `sign-in the other agents use (${CLAUDE_AUTH_SETTINGS_PATH}). ` +
        `The shared sign-in is fine — the other agents are still working.`
      );
    case "instance":
      return (
        `The shared Claude sign-in has stopped working, so ${who} could not start. ` +
        `Sign in again under ${CLAUDE_AUTH_SETTINGS_PATH}. ` +
        `Every agent that shares that sign-in starts working again by itself afterwards — ` +
        `you do not need to fix them one at a time.`
      );
    case "process_env":
      return (
        `${Who} used the Claude sign-in that was set on the server itself, and Claude turned it down. ` +
        `Sign in again under ${CLAUDE_AUTH_SETTINGS_PATH} — that is the sign-in agents share, ` +
        `and it replaces the server's own token for every agent at once.`
      );
    case "none":
      return (
        `There is no Claude sign-in for ${who} to use, so it cannot start. ` +
        `Sign in once under ${CLAUDE_AUTH_SETTINGS_PATH} and this agent — and every other Claude agent ` +
        `without a token of its own — can start working. There is nothing to set up on the agent itself.`
      );
  }
}

/**
 * Employment gate (DUR-3969 acceptance test: employment must never produce an
 * agent that cannot run). A newly employed claude_local agent has no
 * credential wiring of its own by design, so it is ready exactly when a
 * shared sign-in exists for it to inherit.
 */
export function describeClaudeCredentialReadiness(source: ClaudeCredentialSource): {
  ready: boolean;
  message: string | null;
} {
  if (source === "none") {
    return { ready: false, message: buildClaudeAuthOperatorMessage({ source: "none" }) };
  }
  return { ready: true, message: null };
}

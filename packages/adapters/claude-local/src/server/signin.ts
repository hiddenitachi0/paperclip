/**
 * One-click Claude sign-in for the claude_local adapter.
 *
 * The Claude CLI (checked against 2.1.x: `claude setup-token --help` exposes
 * no `--print-url` / non-interactive flag, and with stdin not a TTY it
 * prints nothing at all) only runs its long-lived-token flow inside a
 * terminal. Under a pseudo-terminal it does exactly what we need: it prints
 * the claude.com sign-in URL (as an OSC 8 hyperlink), waits at
 * "Paste code here if prompted >", exchanges the pasted code and prints the
 * resulting `sk-ant-oat01-…` token. This module drives that flow through the
 * util-linux `script` tool (present in the Debian-based server image) so an
 * operator can sign in from the dashboard instead of a shell.
 *
 * Nothing in here ever logs or returns the token except through the
 * `onToken` callback the caller passes to `startClaudeSignInSession`; every
 * human-facing message is passed through `scrubClaudeTokens` first.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { ensurePathInEnv, parseJson } from "@paperclipai/adapter-utils/server-utils";
import { detectClaudeLoginRequired } from "./parse.js";

/** Shape of the long-lived token `claude setup-token` hands out. */
export const CLAUDE_OAUTH_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;
const TOKEN_IN_TEXT_RE = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/g;
const TOKEN_PREFIX_IN_TEXT_RE = /sk-ant-oat01-[A-Za-z0-9_-]*/g;
const OSC8_TARGET_RE = /\x1b\]8;[^;\x07\x1b]*;(https?:\/\/[^\x07\x1b]+)/g;
const PLAIN_URL_RE = /https?:\/\/[^\s"'<>]+/g;
const CLAUDE_OAUTH_URL_HINT_RE = /oauth|authorize|claude|anthropic/i;
const MAX_CAPTURED_OUTPUT_CHARS = 200_000;

export const DEFAULT_CLAUDE_COMMAND = "claude";
export const CLAUDE_SIGNIN_URL_TIMEOUT_MS = 60_000;
export const CLAUDE_SIGNIN_CODE_TIMEOUT_MS = 10 * 60_000;
export const CLAUDE_SIGNIN_EXCHANGE_TIMEOUT_MS = 90_000;

export function looksLikeClaudeOAuthToken(value: string): boolean {
  return CLAUDE_OAUTH_TOKEN_RE.test(value.trim());
}

/** Replace anything token-shaped so a message can be shown or logged. */
export function scrubClaudeTokens(text: string): string {
  return text.replace(TOKEN_PREFIX_IN_TEXT_RE, "sk-ant-oat01-[redacted]");
}

/** Strip CSI, OSC and other escape sequences from terminal output. */
export function stripAnsi(text: string): string {
  return text
    // OSC ... BEL / OSC ... ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI sequences (colours, cursor moves, mode switches)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Two-character escapes (e.g. ESC 7, ESC =)
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n");
}

/**
 * The CLI prints the sign-in URL as an OSC 8 hyperlink; the hyperlink target
 * is complete even when the visible text is wrapped or re-rendered, so it
 * is preferred over the plain text. Falls back to a plain URL scan.
 */
export function extractClaudeSignInUrlFromTerminalOutput(raw: string): string | null {
  const targets: string[] = [];
  for (const match of raw.matchAll(OSC8_TARGET_RE)) {
    if (match[1]) targets.push(match[1]);
  }
  const fromHyperlink = targets.find((url) => CLAUDE_OAUTH_URL_HINT_RE.test(url));
  if (fromHyperlink) return fromHyperlink;

  const plain = stripAnsi(raw);
  for (const match of plain.matchAll(PLAIN_URL_RE)) {
    const url = match[0].replace(/[\])}.!,?;:'"]+$/g, "");
    if (/oauth\/authorize/i.test(url)) return url;
  }
  return null;
}

/** True once the CLI is sitting at its "Paste code here if prompted >" prompt. */
export function terminalOutputAsksForCode(raw: string): boolean {
  const compact = stripAnsi(raw).replace(/\s+/g, "").toLowerCase();
  return compact.includes("pastecode");
}

/**
 * Pull the freshly minted token out of the CLI's success output. Tries the
 * plain text first, then the same text with all whitespace removed in case
 * the terminal wrapped the token across lines.
 */
export function extractClaudeOAuthTokenFromTerminalOutput(raw: string): string | null {
  const plain = stripAnsi(raw);
  const direct = plain.match(TOKEN_IN_TEXT_RE);
  if (direct && direct.length > 0) return direct[direct.length - 1] ?? null;
  const joined = plain.replace(/\s+/g, "");
  const wrapped = joined.match(TOKEN_IN_TEXT_RE);
  if (wrapped && wrapped.length > 0) return wrapped[wrapped.length - 1] ?? null;
  return null;
}

function lastMeaningfulLines(raw: string, maxLines = 4, maxChars = 320): string {
  const lines = stripAnsi(raw)
    .split(/\n/)
    .map((line) => line.replace(/[^\x20-\x7e]/g, "").trim())
    .filter((line) => line.length > 2 && !/^[*✢✶✻✽·\s]+$/.test(line));
  const tail = lines.slice(-maxLines).join(" · ");
  const scrubbed = scrubClaudeTokens(tail);
  return scrubbed.length > maxChars ? `${scrubbed.slice(0, maxChars - 1)}…` : scrubbed;
}

function buildIsolatedClaudeEnv(configDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    // Never let the server's own credentials or a previously bound token
    // leak into the probe; the whole point is to test *this* token.
    if (key.startsWith("ANTHROPIC_")) continue;
    if (key === "CLAUDE_CODE_OAUTH_TOKEN" || key === "CLAUDE_CONFIG_DIR") continue;
    if (key.startsWith("CLAUDE_CODE_USE_")) continue;
    env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  Object.assign(env, extra);
  const withPath = ensurePathInEnv(env);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(withPath)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function makeIsolatedConfigDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

export interface ClaudeTokenVerification {
  ok: boolean;
  /** Plain-language, token-free explanation for the operator. */
  message: string;
  /** True when Claude rejected the credential itself (401-style). */
  authRejected: boolean;
  /** Model the CLI answered with when known — handy proof it really worked. */
  model: string | null;
}

/**
 * One-line CLI call that proves a token works: a single-turn
 * "Reply with exactly OK" through `claude --print` with the token as the only
 * credential and a throwaway CLAUDE_CONFIG_DIR. Costs one tiny request on the
 * subscription.
 */
export async function verifyClaudeOAuthToken(input: {
  token: string;
  command?: string;
  timeoutSec?: number;
  runProcess?: typeof runAdapterExecutionTargetProcess;
}): Promise<ClaudeTokenVerification> {
  const token = input.token.trim();
  if (!looksLikeClaudeOAuthToken(token)) {
    return {
      ok: false,
      authRejected: false,
      model: null,
      message:
        "That does not look like a Claude subscription token. It should start with sk-ant-oat01- and be one long line with no spaces.",
    };
  }
  const command = input.command?.trim() || DEFAULT_CLAUDE_COMMAND;
  const runProcess = input.runProcess ?? runAdapterExecutionTargetProcess;
  const configDir = await makeIsolatedConfigDir("paperclip-claude-verify-");
  try {
    const env = buildIsolatedClaudeEnv(configDir, { CLAUDE_CODE_OAUTH_TOKEN: token });
    const runId = `claude-signin-verify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const proc = await runProcess(
      runId,
      null,
      command,
      ["--print", "-", "--output-format", "json", "--max-turns", "1"],
      {
        cwd: configDir,
        env,
        timeoutSec: Math.max(10, input.timeoutSec ?? 60),
        graceSec: 5,
        stdin: "Reply with exactly OK.",
        onLog: async () => {},
      },
    );
    if (proc.timedOut) {
      return {
        ok: false,
        authRejected: false,
        model: null,
        message: "Claude did not answer in time. Check the server's internet access and try again.",
      };
    }
    const lastJsonLine = proc.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => line.startsWith("{"));
    const parsed = lastJsonLine ? parseJson(lastJsonLine) : null;
    const isError = parsed?.is_error === true;
    const exitOk = (proc.exitCode ?? 1) === 0;
    if (exitOk && parsed && !isError) {
      const modelUsage = parsed.modelUsage;
      const model =
        modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)
          ? Object.keys(modelUsage as Record<string, unknown>)[0] ?? null
          : null;
      return { ok: true, authRejected: false, model, message: "Claude answered. This token works." };
    }
    const loginMeta = detectClaudeLoginRequired({ parsed, stderr: proc.stderr });
    const resultText = typeof parsed?.result === "string" ? parsed.result : "";
    const stderrLine = proc.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
    const detail = scrubClaudeTokens((resultText || stderrLine).replace(/\s+/g, " ").trim()).slice(0, 240);
    const authRejected = loginMeta.requiresLogin || /401|invalid|expired|unauthori[sz]ed|authenticate/i.test(detail);
    return {
      ok: false,
      authRejected,
      model: null,
      message: authRejected
        ? `Claude rejected this token${detail ? ` (${detail})` : ""}. It may have expired or been revoked — sign in again to get a fresh one.`
        : detail
          ? `Claude could not be reached with this token: ${detail}`
          : `Claude exited with code ${proc.exitCode ?? "unknown"} without answering.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      authRejected: false,
      model: null,
      message: /ENOENT/.test(message)
        ? `The Claude CLI ("${command}") is not installed on this server, so the token could not be tested.`
        : `Could not run the Claude CLI to test the token: ${scrubClaudeTokens(message).slice(0, 240)}`,
    };
  } finally {
    await fs.rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// CLI facts (version, whether the automatic flow can run here)
// ---------------------------------------------------------------------------

let cliVersionCache: { command: string; at: number; value: string | null } | null = null;

/** `claude --version` → "2.1.263 (Claude Code)", cached for an hour. */
export async function readClaudeCliVersion(command = DEFAULT_CLAUDE_COMMAND): Promise<string | null> {
  const now = Date.now();
  if (cliVersionCache && cliVersionCache.command === command && now - cliVersionCache.at < 60 * 60_000) {
    return cliVersionCache.value;
  }
  let value: string | null = null;
  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: ensurePathInEnv({ ...process.env }) as NodeJS.ProcessEnv,
    });
    const line = `${result.stdout ?? ""}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
    value = result.status === 0 && line ? line : null;
  } catch {
    value = null;
  }
  cliVersionCache = { command, at: now, value };
  return value;
}

let ptySupportCache: { at: number; value: { supported: boolean; reason: string | null } } | null = null;

/**
 * The automatic flow needs util-linux `script` to give the CLI a
 * pseudo-terminal. BSD/macOS `script` has different flags, so only the
 * util-linux flavour counts as supported.
 */
export function automaticClaudeSignInSupport(): { supported: boolean; reason: string | null } {
  const now = Date.now();
  if (ptySupportCache && now - ptySupportCache.at < 10 * 60_000) return ptySupportCache.value;
  let value: { supported: boolean; reason: string | null };
  try {
    const result = spawnSync("script", ["--version"], { encoding: "utf8", timeout: 5_000 });
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status === 0 && /util-linux/i.test(text)) {
      value = { supported: true, reason: null };
    } else {
      value = {
        supported: false,
        reason: "This server does not have the Linux 'script' tool the automatic sign-in needs. Use the paste option below instead.",
      };
    }
  } catch {
    value = {
      supported: false,
      reason: "This server does not have the Linux 'script' tool the automatic sign-in needs. Use the paste option below instead.",
    };
  }
  ptySupportCache = { at: now, value };
  return value;
}

export function resetClaudeSignInCachesForTests() {
  cliVersionCache = null;
  ptySupportCache = null;
}

// ---------------------------------------------------------------------------
// Interactive sign-in session (setup-token under a pseudo-terminal)
// ---------------------------------------------------------------------------

export type ClaudeSignInSessionStatus =
  | "starting"
  | "awaiting_code"
  | "exchanging"
  | "completed"
  | "failed"
  | "cancelled";

export interface ClaudeSignInSessionSnapshot {
  status: ClaudeSignInSessionStatus;
  loginUrl: string | null;
  /** Plain-language, token-free status line for the operator. */
  message: string | null;
  startedAt: string;
  updatedAt: string;
}

/** Minimal child-process surface so tests can inject a fake. */
export interface ClaudeSignInChild {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stdin: { write(data: string): unknown; end?(): unknown } | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type ClaudeSignInSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => ClaudeSignInChild;

export interface ClaudeSignInSession {
  snapshot(): ClaudeSignInSessionSnapshot;
  /** Feed the code the operator copied from claude.com. Only valid while awaiting_code. */
  submitCode(code: string): void;
  cancel(reason?: string): void;
  /** Resolves once the session reaches a terminal state. */
  done: Promise<ClaudeSignInSessionSnapshot>;
}

export interface StartClaudeSignInSessionOptions {
  command?: string;
  /** Called exactly once with the captured token; if it throws, the session fails with that message. */
  onToken: (token: string) => Promise<void> | void;
  spawn?: ClaudeSignInSpawn;
  urlTimeoutMs?: number;
  codeTimeoutMs?: number;
  exchangeTimeoutMs?: number;
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const defaultSpawn: ClaudeSignInSpawn = (command, args, options) =>
  nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as ClaudeSignInChild;

export function startClaudeSignInSession(options: StartClaudeSignInSessionOptions): ClaudeSignInSession {
  const command = options.command?.trim() || DEFAULT_CLAUDE_COMMAND;
  const spawn = options.spawn ?? defaultSpawn;
  const urlTimeoutMs = options.urlTimeoutMs ?? CLAUDE_SIGNIN_URL_TIMEOUT_MS;
  const codeTimeoutMs = options.codeTimeoutMs ?? CLAUDE_SIGNIN_CODE_TIMEOUT_MS;
  const exchangeTimeoutMs = options.exchangeTimeoutMs ?? CLAUDE_SIGNIN_EXCHANGE_TIMEOUT_MS;

  const startedAt = new Date().toISOString();
  let status: ClaudeSignInSessionStatus = "starting";
  let loginUrl: string | null = null;
  let message: string | null = "Starting the Claude sign-in…";
  let updatedAt = startedAt;
  let output = "";
  let outputSinceSubmit = "";
  let child: ClaudeSignInChild | null = null;
  let configDir: string | null = null;
  let exited = false;
  let tokenHandled = false;
  let phaseTimer: NodeJS.Timeout | null = null;
  let resolveDone!: (snapshot: ClaudeSignInSessionSnapshot) => void;
  const done = new Promise<ClaudeSignInSessionSnapshot>((resolve) => {
    resolveDone = resolve;
  });

  function snapshot(): ClaudeSignInSessionSnapshot {
    return { status, loginUrl, message, startedAt, updatedAt };
  }

  function set(next: ClaudeSignInSessionStatus, nextMessage: string | null) {
    status = next;
    message = nextMessage;
    updatedAt = new Date().toISOString();
  }

  function clearPhaseTimer() {
    if (phaseTimer) clearTimeout(phaseTimer);
    phaseTimer = null;
  }

  function armPhaseTimer(ms: number, onTimeout: () => void) {
    clearPhaseTimer();
    phaseTimer = setTimeout(onTimeout, ms);
    if (typeof phaseTimer.unref === "function") phaseTimer.unref();
  }

  async function cleanup() {
    clearPhaseTimer();
    if (child && !exited) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      const stubborn = child;
      const killTimer = setTimeout(() => {
        if (!exited) {
          try {
            stubborn.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 3_000);
      if (typeof killTimer.unref === "function") killTimer.unref();
    }
    // The captured terminal output may contain the token; drop it.
    output = "";
    outputSinceSubmit = "";
    if (configDir) {
      const dir = configDir;
      configDir = null;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function finish(next: "completed" | "failed" | "cancelled", nextMessage: string) {
    if (status === "completed" || status === "failed" || status === "cancelled") return;
    set(next, scrubClaudeTokens(nextMessage));
    void cleanup().finally(() => resolveDone(snapshot()));
  }

  async function handleToken(token: string) {
    if (tokenHandled) return;
    tokenHandled = true;
    clearPhaseTimer();
    try {
      await options.onToken(token);
      finish("completed", "Signed in. Every Claude agent will use this sign-in from its next run.");
    } catch (err) {
      finish("failed", err instanceof Error ? err.message : "Could not save the sign-in.");
    }
  }

  function onOutput(chunk: Buffer | string) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    output = (output + text).slice(-MAX_CAPTURED_OUTPUT_CHARS);
    if (status === "exchanging") {
      outputSinceSubmit = (outputSinceSubmit + text).slice(-MAX_CAPTURED_OUTPUT_CHARS);
    }
    if (status === "starting") {
      const url = extractClaudeSignInUrlFromTerminalOutput(output);
      if (url) {
        loginUrl = url;
        set(
          "awaiting_code",
          "Open the sign-in link, approve Paperclip, then paste the code Claude shows you here.",
        );
        armPhaseTimer(codeTimeoutMs, () =>
          finish("cancelled", "The sign-in timed out waiting for a code. Start again when you are ready."),
        );
      }
      return;
    }
    if (status === "exchanging") {
      const token = extractClaudeOAuthTokenFromTerminalOutput(outputSinceSubmit);
      if (token) {
        void handleToken(token);
        return;
      }
      if (terminalOutputAsksForCode(outputSinceSubmit)) {
        // The CLI re-prompted instead of exiting: the code was not accepted.
        outputSinceSubmit = "";
        set("awaiting_code", "That code was not accepted. Copy it again from the Claude page and paste it here.");
        armPhaseTimer(codeTimeoutMs, () =>
          finish("cancelled", "The sign-in timed out waiting for a code. Start again when you are ready."),
        );
      }
    }
  }

  function onExit(code: number | null) {
    exited = true;
    if (status === "completed" || status === "failed" || status === "cancelled") return;
    if (status === "exchanging") {
      const token = extractClaudeOAuthTokenFromTerminalOutput(outputSinceSubmit || output);
      if (token) {
        void handleToken(token);
        return;
      }
    }
    const tail = lastMeaningfulLines(output);
    if (status === "starting") {
      finish(
        "failed",
        (code ?? 0) !== 0 || !tail
          ? `The Claude CLI stopped before showing a sign-in link (exit code ${code ?? "unknown"}).${tail ? ` It said: ${tail}` : ""} You can paste a token instead.`
          : `The Claude CLI stopped before showing a sign-in link. It said: ${tail}. You can paste a token instead.`,
      );
      return;
    }
    if (status === "awaiting_code") {
      finish("failed", `The Claude CLI closed before a code was entered.${tail ? ` It said: ${tail}` : ""}`);
      return;
    }
    finish(
      "failed",
      `Claude did not hand back a token after the code was entered.${tail ? ` It said: ${tail}` : ""} Try again, or paste a token instead.`,
    );
  }

  void (async () => {
    try {
      configDir = await makeIsolatedConfigDir("paperclip-claude-signin-");
      const env = buildIsolatedClaudeEnv(configDir, {
        TERM: "xterm-256color",
        // Ink wraps long lines to the terminal width; widen it so the
        // token and the visible URL stay on one line. Prevent the CLI from
        // trying to open a browser on the server.
        BROWSER: "false",
      });
      const inner = `stty cols 400 rows 50 2>/dev/null; exec ${shellQuoteSingle(command)} setup-token`;
      child = spawn("script", ["-q", "-f", "-e", "-c", inner, "/dev/null"], { cwd: configDir, env });
      child.stdout.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      child.on("error", (err) => {
        exited = true;
        finish(
          "failed",
          /ENOENT/.test(err.message)
            ? "This server cannot run the automatic sign-in (the 'script' tool is missing). Paste a token instead."
            : `Could not start the Claude sign-in: ${err.message}`,
        );
      });
      child.on("exit", onExit);
      armPhaseTimer(urlTimeoutMs, () =>
        finish("failed", "The Claude CLI did not show a sign-in link in time. Try again, or paste a token instead."),
      );
    } catch (err) {
      finish("failed", `Could not start the Claude sign-in: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  return {
    snapshot,
    done,
    submitCode(code: string) {
      if (status !== "awaiting_code") {
        throw new Error(
          status === "starting"
            ? "The sign-in link is not ready yet."
            : "This sign-in is no longer waiting for a code. Start a new one.",
        );
      }
      const trimmed = code.trim();
      if (!trimmed || trimmed.length > 512 || /[\s\x00-\x1f\x7f]/.test(trimmed)) {
        throw new Error("Paste the whole code exactly as Claude shows it (one line, no spaces).");
      }
      if (!child?.stdin) {
        finish("failed", "The sign-in process is gone. Start again.");
        throw new Error("The sign-in process is gone. Start again.");
      }
      outputSinceSubmit = "";
      set("exchanging", "Checking the code with Claude…");
      armPhaseTimer(exchangeTimeoutMs, () =>
        finish("failed", "Claude did not finish the sign-in in time. Try again, or paste a token instead."),
      );
      child.stdin.write(`${trimmed}\r`);
    },
    cancel(reason?: string) {
      finish("cancelled", reason ?? "Sign-in cancelled.");
    },
  };
}

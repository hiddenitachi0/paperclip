import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  extractClaudeOAuthTokenFromTerminalOutput,
  extractClaudeSignInUrlFromTerminalOutput,
  looksLikeClaudeOAuthToken,
  scrubClaudeTokens,
  startClaudeSignInSession,
  stripAnsi,
  terminalOutputAsksForCode,
  verifyClaudeOAuthToken,
  type ClaudeSignInChild,
} from "./signin.js";

const FAKE_TOKEN = `sk-ant-oat01-${"A1b2C3d4".repeat(10)}-xyz_AA`;
const SIGNIN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=abc&state=xyz";

// A faithful cut of what `claude setup-token` writes to a pseudo-terminal:
// Ink cursor/colour sequences, a spinner, then the URL as an OSC 8 hyperlink
// whose *visible* text is wrapped, then the paste prompt.
const PTY_OUTPUT_WITH_URL = [
  "\x1b[?25l\x1b[2K\x1b[1G Welcome to Claude Code v2.1.263\r\n",
  "\x1b[2K✢ Opening browser to sign in…\r\n",
  "Browser didn't open? Use the url below to sign in (c to copy)\r\n",
  `\x1b]8;id=snti90;${SIGNIN_URL}\x1b\\${SIGNIN_URL.slice(0, 60)}\r\n${SIGNIN_URL.slice(60)}\x1b]8;;\x1b\\\r\n`,
  "\x1b[2K\x1b[1G Paste code here if prompted > \x1b[?25h",
].join("");

describe("claude sign-in terminal parsers", () => {
  it("recognises the setup-token token shape and nothing else", () => {
    expect(looksLikeClaudeOAuthToken(FAKE_TOKEN)).toBe(true);
    expect(looksLikeClaudeOAuthToken(`  ${FAKE_TOKEN}\n`)).toBe(true);
    expect(looksLikeClaudeOAuthToken("sk-ant-api03-notanoauthtoken")).toBe(false);
    expect(looksLikeClaudeOAuthToken("sk-ant-oat01-short")).toBe(false);
    expect(looksLikeClaudeOAuthToken(`${FAKE_TOKEN} with trailing words`)).toBe(false);
  });

  it("scrubs anything token-shaped out of messages", () => {
    const scrubbed = scrubClaudeTokens(`Your token: ${FAKE_TOKEN}. Keep it safe. Partial sk-ant-oat01-abc`);
    expect(scrubbed).not.toContain(FAKE_TOKEN);
    expect(scrubbed).toBe("Your token: sk-ant-oat01-[redacted]. Keep it safe. Partial sk-ant-oat01-[redacted]");
  });

  it("strips CSI and OSC sequences and turns carriage returns into newlines", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Ghello\x1b]8;;https://x\x1b\\world\x1b]8;;\x1b\\\r\n")).toBe("helloworld\n\n");
  });

  it("prefers the OSC 8 hyperlink target over the wrapped visible URL", () => {
    expect(extractClaudeSignInUrlFromTerminalOutput(PTY_OUTPUT_WITH_URL)).toBe(SIGNIN_URL);
  });

  it("falls back to a plain oauth/authorize URL when there is no hyperlink", () => {
    const plain = `Use the url below to sign in:\n${SIGNIN_URL}\nPaste code here if prompted >`;
    expect(extractClaudeSignInUrlFromTerminalOutput(plain)).toBe(SIGNIN_URL);
    expect(extractClaudeSignInUrlFromTerminalOutput("Welcome to Claude Code")).toBeNull();
    expect(extractClaudeSignInUrlFromTerminalOutput("see https://docs.example.com/page for docs")).toBeNull();
  });

  it("detects the paste prompt even when Ink drops the spaces", () => {
    expect(terminalOutputAsksForCode(PTY_OUTPUT_WITH_URL)).toBe(true);
    expect(terminalOutputAsksForCode("\x1b[2KPastecodehereifprompted>")).toBe(true);
    expect(terminalOutputAsksForCode("Opening browser to sign in…")).toBe(false);
  });

  it("extracts the token from success output, including when the terminal wrapped it", () => {
    const success = `\x1b[32m✓\x1b[0m Long-lived authentication token created (expires in 1 year):\r\n\r\n${FAKE_TOKEN}\r\n\r\nStore this securely.\r\n`;
    expect(extractClaudeOAuthTokenFromTerminalOutput(success)).toBe(FAKE_TOKEN);
    const wrapped = `token:\r\n${FAKE_TOKEN.slice(0, 50)}\r\n${FAKE_TOKEN.slice(50)}\r\n`;
    expect(extractClaudeOAuthTokenFromTerminalOutput(wrapped)).toBe(FAKE_TOKEN);
    expect(extractClaudeOAuthTokenFromTerminalOutput("no token here")).toBeNull();
  });
});

function resultLine(input: Record<string, unknown>) {
  return JSON.stringify({ type: "result", subtype: "success", session_id: "s1", ...input });
}

describe("verifyClaudeOAuthToken", () => {
  it("rejects malformed tokens without spawning anything", async () => {
    const runProcess = vi.fn();
    const result = await verifyClaudeOAuthToken({ token: "nope", runProcess: runProcess as never });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/sk-ant-oat01-/);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("passes the token only via env, in an isolated config dir, and reports success", async () => {
    const runProcess = vi.fn(async (_runId: string, _target: unknown, command: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => {
      expect(command).toBe("claude");
      expect(args).toEqual(["--print", "-", "--output-format", "json", "--max-turns", "1"]);
      expect(args.join(" ")).not.toContain(FAKE_TOKEN);
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(FAKE_TOKEN);
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe(opts.cwd);
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `${resultLine({ is_error: false, result: "OK", modelUsage: { "claude-sonnet-5": {} } })}\n`,
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      };
    });
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    try {
      const result = await verifyClaudeOAuthToken({ token: FAKE_TOKEN, runProcess: runProcess as never });
      expect(result).toEqual({ ok: true, authRejected: false, model: "claude-sonnet-5", message: "Claude answered. This token works." });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("classifies a 401 as a rejected token with a token-free message", async () => {
    const runProcess = vi.fn(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `${resultLine({ is_error: true, result: `Failed to authenticate. API Error: 401 OAuth access token is invalid. ${FAKE_TOKEN}` })}\n`,
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    }));
    const result = await verifyClaudeOAuthToken({ token: FAKE_TOKEN, runProcess: runProcess as never });
    expect(result.ok).toBe(false);
    expect(result.authRejected).toBe(true);
    expect(result.message).toContain("rejected this token");
    expect(result.message).not.toContain(FAKE_TOKEN);
  });

  it("reports a timeout and a missing CLI in plain language", async () => {
    const timedOut = await verifyClaudeOAuthToken({
      token: FAKE_TOKEN,
      runProcess: vi.fn(async () => ({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "", pid: 1, startedAt: null })) as never,
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.message).toMatch(/did not answer in time/);

    const missing = await verifyClaudeOAuthToken({
      token: FAKE_TOKEN,
      runProcess: vi.fn(async () => {
        throw new Error("spawn claude ENOENT");
      }) as never,
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/not installed/);
  });
});

class FakeChild extends EventEmitter implements ClaudeSignInChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed: NodeJS.Signals[] = [];
  stdin = { write: (data: string) => { this.written.push(data); return true; } };
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  emitOutput(text: string) {
    this.stdout.emit("data", Buffer.from(text, "utf8"));
  }
  exit(code: number) {
    this.emit("exit", code, null);
  }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("startClaudeSignInSession", () => {
  it("walks starting → awaiting_code → exchanging → completed and hands the token only to onToken", async () => {
    const child = new FakeChild();
    const spawn = vi.fn((command: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => {
      expect(command).toBe("script");
      expect(args.slice(0, 4)).toEqual(["-q", "-f", "-e", "-c"]);
      expect(args[4]).toContain("'claude' setup-token");
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe(opts.cwd);
      expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      return child;
    });
    const onToken = vi.fn(async () => {});
    const session = startClaudeSignInSession({ onToken, spawn });
    await flush();
    expect(session.snapshot().status).toBe("starting");
    expect(() => session.submitCode("abc")).toThrow(/not ready/);

    child.emitOutput(PTY_OUTPUT_WITH_URL);
    const awaiting = session.snapshot();
    expect(awaiting.status).toBe("awaiting_code");
    expect(awaiting.loginUrl).toBe(SIGNIN_URL);

    expect(() => session.submitCode("has space in it")).toThrow(/one line/);
    session.submitCode("  code123#state456  ");
    expect(child.written).toEqual(["code123#state456\r"]);
    expect(session.snapshot().status).toBe("exchanging");

    child.emitOutput(`\r\nLong-lived authentication token created:\r\n${FAKE_TOKEN}\r\n`);
    await flush();
    expect(onToken).toHaveBeenCalledWith(FAKE_TOKEN);
    const final = await session.done;
    expect(final.status).toBe("completed");
    expect(JSON.stringify(final)).not.toContain(FAKE_TOKEN);
    expect(child.killed.length).toBeGreaterThan(0);
  });

  it("goes back to awaiting_code when the CLI re-prompts after a bad code", async () => {
    const child = new FakeChild();
    const session = startClaudeSignInSession({ onToken: vi.fn(), spawn: () => child });
    await flush();
    child.emitOutput(PTY_OUTPUT_WITH_URL);
    session.submitCode("wrong");
    child.emitOutput("\x1b[31mInvalid code\x1b[0m\r\nPaste code here if prompted > ");
    const snap = session.snapshot();
    expect(snap.status).toBe("awaiting_code");
    expect(snap.message).toMatch(/not accepted/);
    session.cancel();
    expect((await session.done).status).toBe("cancelled");
  });

  it("fails with a token-free explanation when the CLI exits before printing a link", async () => {
    const child = new FakeChild();
    const session = startClaudeSignInSession({ onToken: vi.fn(), spawn: () => child });
    await flush();
    child.emitOutput(`Error: not logged in ${FAKE_TOKEN}\r\n`);
    child.exit(1);
    const final = await session.done;
    expect(final.status).toBe("failed");
    expect(final.message).toMatch(/before showing a sign-in link/);
    expect(final.message).toMatch(/paste a token/i);
    expect(final.message).not.toContain(FAKE_TOKEN);
  });

  it("fails when the token cannot be saved and when the sign-in tool is missing", async () => {
    const child = new FakeChild();
    const session = startClaudeSignInSession({
      onToken: async () => {
        throw new Error("Claude rejected this token.");
      },
      spawn: () => child,
    });
    await flush();
    child.emitOutput(PTY_OUTPUT_WITH_URL);
    session.submitCode("code");
    child.emitOutput(`${FAKE_TOKEN}\r\n`);
    const final = await session.done;
    expect(final.status).toBe("failed");
    expect(final.message).toBe("Claude rejected this token.");

    const missing = new FakeChild();
    const noScript = startClaudeSignInSession({ onToken: vi.fn(), spawn: () => missing });
    await flush();
    missing.emit("error", new Error("spawn script ENOENT"));
    const result = await noScript.done;
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/'script' tool is missing/);
  });

  it("times out waiting for the sign-in link", async () => {
    const child = new FakeChild();
    const session = startClaudeSignInSession({ onToken: vi.fn(), spawn: () => child, urlTimeoutMs: 20 });
    const final = await session.done;
    expect(final.status).toBe("failed");
    expect(final.message).toMatch(/did not show a sign-in link in time/);
  });
});

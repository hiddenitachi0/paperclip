/**
 * DUR-4072 PR1: runs a pinned calculation script (Python, via `uv`) with
 * JSON in, JSON out. The server runs this, never the agent -- an agent can
 * create and test a *draft* script version, but the numbers a report relies
 * on always come from this runner executing an approved, fingerprinted
 * version, not from an agent doing arithmetic in its own workspace.
 *
 * Sandbox, phase 1 (this file). Matches the ticket's four requirements and
 * is honest about what is and is not achieved yet:
 *   - "no network": best-effort. `unshare --net` is attempted first; it
 *     needs CAP_SYS_ADMIN, which the server's container does not grant
 *     itself (agents run as the same `node` user as the server, so granting
 *     it here would hand every agent the same capability). Where it is not
 *     available (logged once, not swallowed), the process still gets no
 *     credentials, no proxy configuration and a stripped PATH, but a script
 *     could still open a raw socket. A hard guarantee needs a sidecar
 *     runner container with `network_mode: none` (tracked as a later PR in
 *     the reporting-framework proposal) -- this is not that yet.
 *   - "time and memory limits": a wall-clock timeout (SIGKILL to the whole
 *     process group) and a `ulimit -v` virtual-memory cap, both real
 *     enforcement today.
 *   - "read-only inputs": the script only ever receives its input on stdin
 *     (never as a file it could edit) and its own runtime directory is
 *     chmod'd read-only after it is built, before any script of that
 *     version ever runs in it.
 *   - fingerprinting: reuses computeCodeFingerprint from trusted-code.ts --
 *     the built venv directory is fingerprinted right after it is built,
 *     and re-checked immediately before every run; a run refuses (status
 *     'fingerprint_mismatch') rather than executing against a directory
 *     that does not match what was built.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeCodeFingerprint, isPathInside } from "./trusted-code.js";
import { logger } from "../middleware/logger.js";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
export const DEFAULT_SCRIPT_MEMORY_LIMIT_MB = 512;
/** Stdout past this many bytes kills the run: a script computes numbers, not gigabytes of text. */
export const MAX_SCRIPT_OUTPUT_BYTES = 10_000_000;
const MAX_STDERR_TAIL_BYTES = 20_000;

export interface ReportScriptRunnerOptions {
  /** Where built venvs live, one subfolder per script sha256. Defaults to ~/.paperclip/report-runtimes. */
  runtimeRoot?: string;
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface ScriptFilesInput {
  sha256: string;
  files: Record<string, string>;
  entrypoint: string;
  lockfile: string | null;
}

export type ReportScriptRunOutcome =
  | { status: "succeeded"; output: unknown; outputSha256: string; runtimeFingerprint: string; durationMs: number; stderrTail: string }
  | { status: "failed"; error: string; runtimeFingerprint: string | null; durationMs: number; stderrTail: string }
  | { status: "timeout"; error: string; runtimeFingerprint: string | null; durationMs: number; stderrTail: string }
  | { status: "fingerprint_mismatch"; error: string; runtimeFingerprint: string | null; durationMs: number; stderrTail: string };

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * The script fingerprint the ticket asks for: a digest over every file
 * (sorted by path, so key order never matters) plus the lockfile and
 * entrypoint. Computed the same shape trusted-code.ts uses for a code root,
 * so "this exact version ran" is provable from the digest alone.
 */
export function computeScriptFingerprint(input: Pick<ScriptFilesInput, "files" | "lockfile" | "entrypoint">): string {
  const lines: string[] = [`E ${input.entrypoint}`];
  for (const relPath of Object.keys(input.files).sort()) {
    lines.push(`F ${relPath} ${sha256Hex(input.files[relPath]!)}`);
  }
  lines.push(`L ${input.lockfile ? sha256Hex(input.lockfile) : ""}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function defaultRuntimeRoot(): string {
  return path.join(os.homedir(), ".paperclip", "report-runtimes");
}

/** Refuses a path that would land outside `root` -- defense in depth behind the validators/report.ts input check. */
function assertRelativeAndContained(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) throw new Error(`Report script file path must be relative: ${relPath}`);
  const abs = path.resolve(root, relPath);
  if (!isPathInside(abs, root)) throw new Error(`Report script file path escapes its runtime directory: ${relPath}`);
  return abs;
}

async function chmodRecursive(root: string, dirMode: number, fileMode: number): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await chmodRecursive(abs, dirMode, fileMode);
      await fsp.chmod(abs, dirMode);
    } else {
      await fsp.chmod(abs, fileMode);
    }
  }
}

let networkNamespaceSupport: boolean | null = null;

/** Probed once per process: can this environment actually create a network namespace? Logged, never assumed. */
async function canUnshareNetwork(): Promise<boolean> {
  if (networkNamespaceSupport !== null) return networkNamespaceSupport;
  networkNamespaceSupport = await new Promise<boolean>((resolve) => {
    // Must match the exact flags used in run() below -- --map-root-user asks
    // for an unprivileged user namespace too, which some kernels allow
    // without CAP_SYS_ADMIN even when a bare `--net` would be refused, so
    // testing a different flag combination here would misreport what run()
    // can actually do.
    const child = spawn("unshare", ["--net", "--map-root-user", "--", "true"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
  if (!networkNamespaceSupport) {
    logger.warn(
      "report-script-runner: this environment cannot create a network namespace (unshare --net failed); " +
        "report scripts run without network isolation until the sidecar runner container ships. " +
        "Mitigated by an empty environment, a stripped PATH and no credentials -- not a substitute for real isolation.",
    );
  }
  return networkNamespaceSupport;
}

export interface ReportScriptRunner {
  /** Builds (or reuses) the runtime directory for a script version and returns its fingerprint. */
  ensureRuntime(script: ScriptFilesInput): Promise<{ runtimeDir: string; fingerprint: string; hasVenv: boolean }>;
  /** Runs the script's entrypoint with `input` on stdin. Never throws; every failure is a typed outcome. */
  run(script: ScriptFilesInput, input: unknown): Promise<ReportScriptRunOutcome>;
}

export function reportScriptRunner(options: ReportScriptRunnerOptions = {}): ReportScriptRunner {
  const runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_SCRIPT_MEMORY_LIMIT_MB;

  async function buildRuntime(script: ScriptFilesInput, runtimeDir: string): Promise<void> {
    await fsp.rm(runtimeDir, { recursive: true, force: true });
    await fsp.mkdir(runtimeDir, { recursive: true, mode: 0o755 });
    for (const [relPath, content] of Object.entries(script.files)) {
      const abs = assertRelativeAndContained(runtimeDir, relPath);
      await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
      await fsp.writeFile(abs, content, { encoding: "utf8", mode: 0o644 });
    }
    if (script.lockfile) {
      await fsp.writeFile(path.join(runtimeDir, "uv.lock"), script.lockfile, { encoding: "utf8", mode: 0o644 });
      const hasPyproject = Object.keys(script.files).some((p) => p === "pyproject.toml");
      if (hasPyproject) {
        await runSetupCommand(runtimeDir, "uv", ["sync", "--frozen", "--locked"]);
      }
    }
    // Read-only from here on: this version's runtime never changes again
    // until it is rebuilt from scratch above, and no script running inside
    // it may edit its own code or dependencies.
    await chmodRecursive(runtimeDir, 0o555, 0o444);
    await fsp.chmod(runtimeDir, 0o555);
  }

  async function runSetupCommand(cwd: string, cmd: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: cwd },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.slice(-MAX_STDERR_TAIL_BYTES)}`));
      });
    });
  }

  async function ensureRuntime(script: ScriptFilesInput): Promise<{ runtimeDir: string; fingerprint: string; hasVenv: boolean }> {
    const runtimeDir = path.join(runtimeRoot, script.sha256);
    const fingerprintMarker = path.join(runtimeRoot, `${script.sha256}.fingerprint`);
    const exists = fs.existsSync(runtimeDir);
    if (exists) {
      const current = await computeCodeFingerprint(runtimeDir, { appRoot: runtimeRoot });
      const recorded = await fsp.readFile(fingerprintMarker, "utf8").catch(() => null);
      if (recorded && recorded.trim() === current.digest) {
        return { runtimeDir, fingerprint: current.digest, hasVenv: fs.existsSync(path.join(runtimeDir, ".venv")) };
      }
      // Built directory does not match what was recorded when it was built:
      // something (an agent running as the same user, or a partial/failed
      // previous build) touched it since. Never trust it -- rebuild fresh,
      // the same defensive move trusted-code.ts's prepareSharedFolder makes
      // for a shared add-on folder.
      logger.warn({ runtimeDir }, "report-script-runner: runtime directory fingerprint mismatch; rebuilding from scratch");
    }
    await fsp.mkdir(runtimeRoot, { recursive: true, mode: 0o755 });
    await buildRuntime(script, runtimeDir);
    const hasVenv = fs.existsSync(path.join(runtimeDir, ".venv"));
    const fingerprint = await computeCodeFingerprint(runtimeDir, { appRoot: runtimeRoot });
    await fsp.writeFile(fingerprintMarker, fingerprint.digest, "utf8");
    return { runtimeDir, fingerprint: fingerprint.digest, hasVenv };
  }

  async function run(script: ScriptFilesInput, input: unknown): Promise<ReportScriptRunOutcome> {
    const startedAt = Date.now();
    let runtimeDir: string;
    let fingerprint: string;
    let hasVenv: boolean;
    try {
      ({ runtimeDir, fingerprint, hasVenv } = await ensureRuntime(script));
    } catch (err) {
      return {
        status: "failed",
        error: `Could not prepare the script's runtime: ${err instanceof Error ? err.message : String(err)}`,
        runtimeFingerprint: null,
        durationMs: Date.now() - startedAt,
        stderrTail: "",
      };
    }

    // Re-check immediately before running, not just at build time: this is
    // the "before loading, re-hash and refuse if changed" half of the
    // trusted-code.ts pattern the ticket asks for.
    const preRun = await computeCodeFingerprint(runtimeDir, { appRoot: runtimeRoot }).catch(() => null);
    if (!preRun || preRun.digest !== fingerprint) {
      return {
        status: "fingerprint_mismatch",
        error: "The script's runtime directory changed since it was built and fingerprinted; refusing to run it.",
        runtimeFingerprint: preRun?.digest ?? null,
        durationMs: Date.now() - startedAt,
        stderrTail: "",
      };
    }

    const netnsAvailable = await canUnshareNetwork();
    const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "paperclip-report-run-"));
    try {
      const innerCmd = hasVenv
        ? `uv run --no-sync python3 ${JSON.stringify(script.entrypoint)}`
        : `python3 ${JSON.stringify(script.entrypoint)}`;
      const guarded = `ulimit -v ${memoryLimitMb * 1024}; exec ${innerCmd}`;
      const args = netnsAvailable
        ? ["--net", "--map-root-user", "--", "bash", "-c", guarded]
        : ["-c", guarded];
      const cmd = netnsAvailable ? "unshare" : "bash";

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; truncated: boolean }>(
        (resolve, reject) => {
          const child = spawn(cmd, args, {
            cwd: runtimeDir,
            env: {
              PATH: "/usr/local/bin:/usr/bin:/bin",
              HOME: scratchDir,
              TMPDIR: scratchDir,
              LANG: "C.UTF-8",
            },
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          });

          let stdout = "";
          let stderr = "";
          let truncated = false;
          let settled = false;

          const timer = setTimeout(() => {
            if (settled) return;
            try {
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }, timeoutMs);

          child.stdout?.on("data", (chunk: Buffer) => {
            if (stdout.length < MAX_SCRIPT_OUTPUT_BYTES) {
              stdout += chunk.toString("utf8");
            } else if (!truncated) {
              truncated = true;
              try {
                if (child.pid) process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_TAIL_BYTES);
          });
          child.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          });
          child.on("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, truncated });
          });

          child.stdin?.end(JSON.stringify(input ?? null));
        },
      );

      const durationMs = Date.now() - startedAt;
      if (result.truncated) {
        return {
          status: "failed",
          error: `The script's output exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes and was stopped.`,
          runtimeFingerprint: fingerprint,
          durationMs,
          stderrTail: result.stderr,
        };
      }
      if (result.signal === "SIGKILL") {
        return {
          status: "timeout",
          error: `The script did not finish within ${timeoutMs}ms and was stopped.`,
          runtimeFingerprint: fingerprint,
          durationMs,
          stderrTail: result.stderr,
        };
      }
      if (result.code !== 0) {
        return {
          status: "failed",
          error: `The script exited with status ${result.code}.`,
          runtimeFingerprint: fingerprint,
          durationMs,
          stderrTail: result.stderr,
        };
      }
      let output: unknown;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        return {
          status: "failed",
          error: "The script's stdout was not valid JSON.",
          runtimeFingerprint: fingerprint,
          durationMs,
          stderrTail: result.stderr,
        };
      }
      return {
        status: "succeeded",
        output,
        outputSha256: sha256Hex(result.stdout),
        runtimeFingerprint: fingerprint,
        durationMs,
        stderrTail: result.stderr,
      };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        runtimeFingerprint: fingerprint,
        durationMs: Date.now() - startedAt,
        stderrTail: "",
      };
    } finally {
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { ensureRuntime, run };
}

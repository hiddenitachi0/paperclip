/**
 * DUR-4072 PR1: runs a calculation script (Python, standard library only)
 * with JSON in on stdin and JSON out on stdout. The server runs this, never
 * the agent.
 *
 * READ THIS BEFORE TRUSTING IT -- what this runner is and is NOT:
 *
 *   * It is NOT a sandbox. The script runs as the same operating-system
 *     user as the Paperclip server (and every agent). That user can read
 *     the server's files and, on Linux, /proc/<server pid>/environ; it can
 *     reach internal hosts unless the network namespace below is available.
 *     So approving a script version means TRUSTING that code with server
 *     privileges. That is why nothing reaches this runner unless a company
 *     owner/admin (a person) approved that exact source digest first --
 *     see report-scripts.ts. A real sandbox (separate container with its own
 *     uid and no network) is a later step in the reporting plan.
 *
 *   * What it does enforce, per run (all tested in report-script-runner.test.ts):
 *       - a fresh directory per run, written from the files the caller
 *         passes (the service reads them from the database and re-checks
 *         their digest first); no cached runtime is ever reused, so there
 *         is no on-disk marker anyone could tamper with;
 *       - an empty environment (no secrets, tokens or proxy settings), and
 *         `python3 -E -s -S -B`: environment variables, user site-packages
 *         and site-packages are ignored, so only the standard library loads;
 *       - no package install step of any kind;
 *       - `ulimit -u 1`: the script cannot start any other process or
 *         thread. That also means it cannot fork and `setsid` a child to
 *         outlive the run -- there is no child to escape. (Process limits
 *         are ignored for root, so the runner refuses to run as root.);
 *       - CPU time (`ulimit -t`), virtual memory (`ulimit -v`), the size
 *         of any single file it writes (`ulimit -f`), no core dumps;
 *       - a wall-clock timeout that SIGKILLs the whole process group;
 *       - a cap on stdout, and a cap on the total size of its scratch
 *         directory (checked while it runs; the run is killed past it).
 *         Files written OUTSIDE the scratch directory are bounded only by
 *         the per-file size limit -- another reason approval = trust.
 *       - no network where the kernel lets an unprivileged process create
 *         a network namespace (`unshare --net --map-root-user`); where it
 *         does not (typical inside the production container) this is
 *         logged once and the script DOES have network access.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "./trusted-code.js";
import { logger } from "../middleware/logger.js";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
export const DEFAULT_SCRIPT_CPU_SECONDS = 30;
export const DEFAULT_SCRIPT_MEMORY_LIMIT_MB = 512;
/** Largest single file the script may write anywhere (MB). */
export const DEFAULT_SCRIPT_MAX_FILE_MB = 20;
/** Largest total size of the run's scratch directory (MB). */
export const DEFAULT_SCRIPT_MAX_SCRATCH_MB = 50;
/** Stdout past this many bytes kills the run: a script computes numbers, not gigabytes of text. */
export const MAX_SCRIPT_OUTPUT_BYTES = 10_000_000;
const MAX_STDERR_TAIL_BYTES = 20_000;
const SCRATCH_POLL_MS = 250;

export interface ReportScriptRunnerOptions {
  timeoutMs?: number;
  cpuSeconds?: number;
  memoryLimitMb?: number;
  maxFileMb?: number;
  maxScratchMb?: number;
  /** Parent folder for the per-run directories. Defaults to the OS temp dir. */
  workRoot?: string;
  /** Tests only: skip the network-namespace probe and run without it. */
  disableNetworkNamespace?: boolean;
}

export interface ScriptFilesInput {
  files: Record<string, string>;
  entrypoint: string;
}

type OutcomeBase = { runtimeFingerprint: string | null; durationMs: number; stderrTail: string };
export type ReportScriptRunOutcome =
  | ({ status: "succeeded"; output: unknown; outputSha256: string } & OutcomeBase)
  | ({ status: "failed"; error: string } & OutcomeBase)
  | ({ status: "timeout"; error: string } & OutcomeBase)
  | ({ status: "fingerprint_mismatch"; error: string } & OutcomeBase);

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * The script digest: entrypoint plus every file (sorted by path, so key
 * order never matters). The service recomputes this from the DATABASE row
 * before every run and compares it with the approved digest.
 */
export function computeScriptFingerprint(input: ScriptFilesInput): string {
  const lines: string[] = [`E ${input.entrypoint}`];
  for (const relPath of Object.keys(input.files).sort()) {
    lines.push(`F ${relPath} ${sha256Hex(input.files[relPath]!)}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Refuses a path that would land outside `root` -- defense in depth behind the validators/report.ts input check. */
function assertRelativeAndContained(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) throw new Error(`Report script file path must be relative: ${relPath}`);
  const abs = path.resolve(root, relPath);
  if (!isPathInside(abs, root)) throw new Error(`Report script file path escapes its runtime directory: ${relPath}`);
  return abs;
}

async function chmodTree(root: string, dirMode: number, fileMode: number): Promise<void> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await chmodTree(abs, dirMode, fileMode);
      await fsp.chmod(abs, dirMode);
    } else {
      await fsp.chmod(abs, fileMode);
    }
  }
  await fsp.chmod(root, dirMode);
}

async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else {
        const st = await fsp.lstat(abs).catch(() => null);
        if (st) total += st.size;
      }
    }
  }
  return total;
}

let networkNamespaceSupport: boolean | null = null;

/** Probed once per process: can this environment create a network namespace unprivileged? Logged, never assumed. */
async function canUnshareNetwork(): Promise<boolean> {
  if (networkNamespaceSupport !== null) return networkNamespaceSupport;
  networkNamespaceSupport = await new Promise<boolean>((resolve) => {
    const child = spawn("unshare", ["--net", "--map-root-user", "--", "true"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
  if (!networkNamespaceSupport) {
    logger.warn(
      "report-script-runner: cannot create a network namespace here (unshare --net failed); approved report " +
        "scripts run WITH network access, as the server's user. Only approve scripts you trust.",
    );
  }
  return networkNamespaceSupport;
}

/** Single-quotes a value for bash. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ReportScriptRunner {
  /** Runs the entrypoint with `input` on stdin. Never throws; every failure is a typed outcome. */
  run(script: ScriptFilesInput, input: unknown): Promise<ReportScriptRunOutcome>;
}

export function reportScriptRunner(options: ReportScriptRunnerOptions = {}): ReportScriptRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const cpuSeconds = options.cpuSeconds ?? DEFAULT_SCRIPT_CPU_SECONDS;
  const memoryLimitMb = options.memoryLimitMb ?? DEFAULT_SCRIPT_MEMORY_LIMIT_MB;
  const maxFileMb = options.maxFileMb ?? DEFAULT_SCRIPT_MAX_FILE_MB;
  const maxScratchBytes = (options.maxScratchMb ?? DEFAULT_SCRIPT_MAX_SCRATCH_MB) * 1024 * 1024;

  async function run(script: ScriptFilesInput, input: unknown): Promise<ReportScriptRunOutcome> {
    const startedAt = Date.now();
    const fingerprint = computeScriptFingerprint(script);
    const fail = (error: string, stderrTail = ""): ReportScriptRunOutcome => ({
      status: "failed",
      error,
      runtimeFingerprint: fingerprint,
      durationMs: Date.now() - startedAt,
      stderrTail,
    });

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return fail(
        "Refusing to run a report script as root: the process limits that stop it starting other programs do not apply to root.",
      );
    }

    let workDir: string | null = null;
    try {
      workDir = await fsp.mkdtemp(path.join(options.workRoot ?? os.tmpdir(), "paperclip-report-run-"));
      const codeDir = path.join(workDir, "code");
      const scratchDir = path.join(workDir, "scratch");
      await fsp.mkdir(codeDir, { mode: 0o755 });
      await fsp.mkdir(scratchDir, { mode: 0o700 });
      for (const [relPath, content] of Object.entries(script.files)) {
        const abs = assertRelativeAndContained(codeDir, relPath);
        await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
        await fsp.writeFile(abs, content, { encoding: "utf8", mode: 0o644 });
      }
      // Read-only as a courtesy, not a guarantee: inside the optional user
      // namespace the script is "root" and could still write here. It does
      // not matter -- this copy is thrown away after the run, and the next
      // run is written fresh from the database.
      await chmodTree(codeDir, 0o555, 0o444);
      const entryAbs = assertRelativeAndContained(codeDir, script.entrypoint);

      const netns = options.disableNetworkNamespace ? false : await canUnshareNetwork();
      const python = `python3 -E -s -S -B ${shq(entryAbs)}`;
      const guarded = [
        `ulimit -c 0`,
        // Soft limit sends SIGXCPU (reported as "used too much CPU"); the
        // hard limit two seconds later is the kernel's SIGKILL backstop.
        `ulimit -S -t ${Math.max(1, Math.floor(cpuSeconds))}`,
        `ulimit -H -t ${Math.max(1, Math.floor(cpuSeconds)) + 2}`,
        `ulimit -v ${Math.floor(memoryLimitMb * 1024)}`,
        // bash's ulimit -f counts 1024-byte blocks.
        `ulimit -f ${Math.floor(maxFileMb * 1024)}`,
        // Last, so the limits above are set before forking is switched off.
        `ulimit -u 1`,
        netns ? `exec unshare --net --map-root-user -- ${python}` : `exec ${python}`,
      ].join(" && ");

      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
        killedFor: "output" | "timeout" | "scratch" | null;
      }>((resolve, reject) => {
        const child = spawn("bash", ["-c", guarded], {
          cwd: codeDir,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: scratchDir, TMPDIR: scratchDir, LANG: "C.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        let stdout = "";
        let stdoutBytes = 0;
        let stderr = "";
        let killedFor: "output" | "timeout" | "scratch" | null = null;
        let settled = false;

        const killGroup = (reason: "output" | "timeout" | "scratch") => {
          if (!killedFor) killedFor = reason;
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            /* group already gone */
          }
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        };

        const timer = setTimeout(() => killGroup("timeout"), timeoutMs);
        let polling = false;
        const scratchPoll = setInterval(() => {
          if (polling || settled) return;
          polling = true;
          void directorySizeBytes(scratchDir)
            .then((size) => {
              if (size > maxScratchBytes && !settled) killGroup("scratch");
            })
            .finally(() => {
              polling = false;
            });
        }, SCRATCH_POLL_MS);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes <= MAX_SCRIPT_OUTPUT_BYTES) stdout += chunk.toString("utf8");
          else killGroup("output");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_TAIL_BYTES);
        });
        child.stdin?.on("error", () => {
          /* script exited without reading stdin */
        });
        const finish = () => {
          settled = true;
          clearTimeout(timer);
          clearInterval(scratchPoll);
        };
        child.on("error", (err) => {
          if (settled) return;
          finish();
          reject(err);
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          finish();
          resolve({ code, signal, stdout, stderr, killedFor });
        });

        child.stdin?.end(JSON.stringify(input ?? null));
      });

      const durationMs = Date.now() - startedAt;
      const base = { runtimeFingerprint: fingerprint, durationMs, stderrTail: result.stderr };
      if (result.killedFor === "output") {
        return { status: "failed", error: `The script's output exceeded ${MAX_SCRIPT_OUTPUT_BYTES} bytes and was stopped.`, ...base };
      }
      if (result.killedFor === "scratch") {
        return {
          status: "failed",
          error: `The script wrote more than ${Math.round(maxScratchBytes / 1024 / 1024)} MB to its scratch folder and was stopped.`,
          ...base,
        };
      }
      if (result.killedFor === "timeout") {
        return { status: "timeout", error: `The script did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, ...base };
      }
      if (result.signal === "SIGXCPU" || result.signal === "SIGKILL") {
        return { status: "timeout", error: `The script used more than ${cpuSeconds} seconds of CPU time and was stopped.`, ...base };
      }
      if (result.signal === "SIGXFSZ") {
        return { status: "failed", error: `The script tried to write a file larger than ${maxFileMb} MB and was stopped.`, ...base };
      }
      if (result.code !== 0) {
        return { status: "failed", error: `The script exited with status ${result.code ?? result.signal}.`, ...base };
      }
      let output: unknown;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        return { status: "failed", error: "The script's output was not valid JSON.", ...base };
      }
      return { status: "succeeded", output, outputSha256: sha256Hex(result.stdout), ...base };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      if (workDir) {
        const dir = workDir;
        await chmodTree(dir, 0o755, 0o644).catch(() => {});
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  return { run };
}

/**
 * DUR-3994 Stage 1: the server keeps its own keys in memory only.
 *
 * Before this, the server's keys (the sign-in key, the database addresses
 * with their passwords, the Anthropic key, ...) sat in the server's
 * environment. Removing a name from `process.env` inside Node does not change
 * `/proc/<server pid>/environ` -- that is the record of the environment the
 * process was STARTED with -- and every agent runs as the same Linux user as
 * the server, so any agent could read it.
 *
 * Now:
 *  - The container entrypoint (scripts/docker-entrypoint.sh, still running as
 *    root) takes the values out of the environment it hands to the server and
 *    passes them through a one-shot pipe on a file descriptor instead
 *    (`PAPERCLIP_SECRETS_FD`, lines of `NAME=base64(value)`).
 *  - `captureServerSecrets()` (run by server-secrets-boot.ts, the very first
 *    import of index.ts) reads that pipe, closes it at once so no agent can
 *    inherit it, and keeps the values in a private map. Any secret name still
 *    in `process.env` (installs started without the entrypoint, e.g.
 *    `pnpm dev`) is moved into the same map and deleted from `process.env`.
 *  - Everything in the server reads its keys through `readServerSecret()`.
 *
 * This module never writes a secret value into `process.env`, never logs a
 * value, and never throws while capturing: a malformed hand-over is reported
 * by name only and the server carries on with whatever it did receive (the
 * sign-in check then refuses to start the server if the key is missing, and
 * the deploy runner rolls back on failed health).
 */
import { closeSync, readFileSync } from "node:fs";
import {
  isServerSecretEnvName,
  registerServerSecretValuesReader,
} from "@paperclipai/adapter-utils/server-env-secrets";

export const SERVER_SECRETS_FD_ENV = "PAPERCLIP_SECRETS_FD";

const vault = new Map<string, string>();
let handoffUsed = false;
let registered = false;

type DescriptorIo = {
  readFileSync: (fd: number) => Buffer;
  closeSync: (fd: number) => void;
};

const defaultIo: DescriptorIo = {
  readFileSync: (fd) => readFileSync(fd),
  closeSync: (fd) => closeSync(fd),
};

export type CaptureServerSecretsResult = {
  /** Names received through the descriptor. */
  fromDescriptor: string[];
  /** Names moved out of process.env into memory. */
  fromEnvironment: string[];
  /** Plain problems, names only (never a value). */
  problems: string[];
};

function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  registerServerSecretValuesReader(() => vault.entries());
}

function warn(message: string): void {
  // The logger is not loaded yet at boot (and must not be: it reads config).
  try {
    process.stderr.write(`[server-secrets] ${message}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Parse the hand-over text: one `NAME=base64(value)` per line. Only names on
 * the server-secret list are accepted; anything else is ignored by name.
 */
export function parseServerSecretsHandoff(text: string): {
  values: Map<string, string>;
  problems: string[];
} {
  const values = new Map<string, string>();
  const problems: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      problems.push("a hand-over line without a name was ignored");
      continue;
    }
    const name = line.slice(0, eq);
    const encoded = line.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !isServerSecretEnvName(name)) {
      problems.push(`ignored ${/^[A-Za-z0-9_]{1,80}$/.test(name) ? name : "an unexpected name"} (not a server key)`);
      continue;
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      problems.push(`ignored ${name} (not base64)`);
      continue;
    }
    values.set(name, Buffer.from(encoded, "base64").toString("utf8"));
  }
  return { values, problems };
}

/**
 * Take the server's keys into memory: first from the entrypoint's descriptor
 * (if any), then any server-secret names still in `env`. Safe to call more
 * than once; values already held are kept.
 */
export function captureServerSecrets(
  env: NodeJS.ProcessEnv = process.env,
  io: DescriptorIo = defaultIo,
): CaptureServerSecretsResult {
  ensureRegistered();
  const result: CaptureServerSecretsResult = { fromDescriptor: [], fromEnvironment: [], problems: [] };

  const fdRaw = env[SERVER_SECRETS_FD_ENV];
  if (fdRaw !== undefined) {
    delete env[SERVER_SECRETS_FD_ENV];
    const fd = /^\d+$/.test(fdRaw.trim()) ? Number(fdRaw.trim()) : NaN;
    if (!Number.isInteger(fd) || fd < 3) {
      result.problems.push(`${SERVER_SECRETS_FD_ENV} is not a usable descriptor number`);
    } else {
      handoffUsed = true;
      let text = "";
      try {
        text = io.readFileSync(fd).toString("utf8");
      } catch (err) {
        result.problems.push(`could not read the key hand-over (${(err as NodeJS.ErrnoException)?.code ?? "error"})`);
      } finally {
        try {
          io.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      const parsed = parseServerSecretsHandoff(text);
      result.problems.push(...parsed.problems);
      for (const [name, value] of parsed.values) {
        vault.set(name, value);
        result.fromDescriptor.push(name);
      }
    }
  }

  for (const name of Object.keys(env)) {
    if (!isServerSecretEnvName(name)) continue;
    const value = env[name];
    if (typeof value === "string" && !vault.has(name)) {
      vault.set(name, value);
      result.fromEnvironment.push(name);
    }
    delete env[name];
  }

  for (const problem of result.problems) warn(problem);
  return result;
}

/**
 * The server's own value for a secret name, or undefined. Values held in
 * memory win; otherwise `process.env` is consulted (tests, and any code path
 * that runs before capture).
 */
export function readServerSecret(name: string): string | undefined {
  const held = vault.get(name);
  if (held !== undefined) return held;
  const fromEnv = process.env[name];
  return typeof fromEnv === "string" ? fromEnv : undefined;
}

/** The value held in memory for `name` (never consults process.env). */
export function readHeldServerSecret(name: string): string | undefined {
  return vault.get(name);
}

/** Keep one value in memory (used by the older single-key capture). */
export function holdServerSecret(name: string, value: string): void {
  ensureRegistered();
  vault.set(name, value);
}

/** A plain object of the given names' values, for helpers that take an env. */
export function serverSecretEnv(names: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = readServerSecret(name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** True when this server received its keys through the entrypoint hand-over. */
export function serverSecretsHandoffUsed(): boolean {
  return handoffUsed;
}

/**
 * config.ts loads `instances/<id>/.env` (and a `.env` in the working
 * directory) into the environment. Server-secret names in those files must
 * never land in `process.env` (agents would inherit them), and must not be
 * able to plant a key: an agent can write that file, so a value there could
 * otherwise become, say, the key that signs agent tokens after the next
 * restart.
 *
 * Returns the entries that may go into `process.env` (every non-secret name,
 * unchanged). Secret names are:
 *  - ignored when the server received its keys through the entrypoint
 *    hand-over (the Docker image: its keys come from the deploy settings, not
 *    from a file agents can write), reported by name;
 *  - otherwise (local installs: `paperclipai onboard` writes the agent-token
 *    key there) kept in memory only, never in `process.env`, and only when
 *    the real environment did not already provide that name.
 */
export function adoptServerSecretsFromEnvFile(
  entries: Record<string, string>,
  sourceLabel: string,
): Record<string, string> {
  ensureRegistered();
  const passThrough: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [name, value] of Object.entries(entries)) {
    if (!isServerSecretEnvName(name)) {
      passThrough[name] = value;
      continue;
    }
    if (handoffUsed) {
      ignored.push(name);
      continue;
    }
    if (!vault.has(name) && process.env[name] === undefined) {
      vault.set(name, value);
    }
  }
  if (ignored.length > 0) {
    warn(
      `ignored ${ignored.join(", ")} in ${sourceLabel}: this server takes its keys from its deploy settings only`,
    );
  }
  return passThrough;
}

/** Test hook: forget everything held in memory (or just the given names). */
export function resetServerSecretsForTests(names?: readonly string[]): void {
  if (names) {
    for (const name of names) vault.delete(name);
    return;
  }
  vault.clear();
  handoffUsed = false;
}

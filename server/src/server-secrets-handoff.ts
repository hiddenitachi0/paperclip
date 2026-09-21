/**
 * DUR-3994 Stage 1: run by scripts/docker-entrypoint.sh as ROOT, just before
 * it drops to the `node` user and starts the server.
 *
 * It works out which of the server's keys to hand over and prints, on
 * stdout, for the entrypoint only:
 *
 *   UNSET <every server-secret name present in the environment>
 *   <NAME>=<base64(value)>            (one line per key with a value)
 *
 * Values come from the root-only secrets file (Compose secret
 * `paperclip_server`, mounted at /run/secrets/paperclip_server) when it has
 * one for that name, otherwise from the environment. The entrypoint writes
 * the NAME=... lines into a one-shot pipe on descriptor 3 and removes every
 * UNSET name from the server's environment, so none of the values is in
 * /proc/<server>/environ. When there is nothing to hand over it prints
 * nothing and the entrypoint starts the server exactly as before.
 *
 * Which names count as server keys comes from the single list in
 * @paperclipai/adapter-utils/server-env-secrets. Nothing here ever prints a
 * value except base64-encoded into the entrypoint's own pipe; errors name
 * the problem only, then exit non-zero so the entrypoint falls back to the
 * old start.
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { isServerSecretEnvName } from "@paperclipai/adapter-utils/server-env-secrets";

export const DEFAULT_SERVER_SECRETS_FILE = "/run/secrets/paperclip_server";

export type ServerSecretsHandoff = {
  /** Every server-secret name in the environment (blank ones too). */
  unsetNames: string[];
  /** name -> value to hand over (non-blank values only). */
  values: Map<string, string>;
  /** Names in the secrets file that are not server keys (ignored). */
  ignoredFileNames: string[];
};

function nonBlank(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildServerSecretsHandoff(input: {
  env: NodeJS.ProcessEnv;
  fileText?: string | null;
}): ServerSecretsHandoff {
  const fileEntries = input.fileText ? parseDotenv(input.fileText) : {};
  const unsetNames = Object.keys(input.env).filter(isServerSecretEnvName).sort();
  const values = new Map<string, string>();
  const ignoredFileNames: string[] = [];

  for (const [name, value] of Object.entries(fileEntries)) {
    if (!isServerSecretEnvName(name)) {
      ignoredFileNames.push(name);
      continue;
    }
    if (nonBlank(value)) values.set(name, value);
  }
  for (const name of unsetNames) {
    if (values.has(name)) continue;
    const value = input.env[name];
    if (nonBlank(value)) values.set(name, value);
  }
  return { unsetNames, values, ignoredFileNames };
}

export function formatServerSecretsHandoff(handoff: ServerSecretsHandoff): string {
  if (handoff.values.size === 0) return "";
  const lines = [`UNSET ${handoff.unsetNames.join(" ")}`.trimEnd()];
  for (const [name, value] of [...handoff.values.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}=${Buffer.from(value, "utf8").toString("base64")}`);
  }
  return `${lines.join("\n")}\n`;
}

function main(): number {
  const filePath = process.argv[2] || DEFAULT_SERVER_SECRETS_FILE;
  let fileText: string | null = null;
  if (existsSync(filePath)) {
    try {
      fileText = readFileSync(filePath, "utf8");
    } catch (err) {
      process.stderr.write(
        `server-secrets-handoff: cannot read the secrets file (${(err as NodeJS.ErrnoException)?.code ?? "error"})\n`,
      );
      return 1;
    }
  }
  const handoff = buildServerSecretsHandoff({ env: process.env, fileText });
  if (handoff.ignoredFileNames.length > 0) {
    process.stderr.write(
      `server-secrets-handoff: ignored ${handoff.ignoredFileNames.join(", ")} in the secrets file (not server keys)\n`,
    );
  }
  process.stdout.write(formatServerSecretsHandoff(handoff));
  return 0;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = main();
}

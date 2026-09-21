/**
 * DUR-3994 Stage 1: prints the list of the server's key NAMES (never a
 * value) for the container entrypoint.
 *
 * The entrypoint runs as root, so nothing it runs may live where an agent can
 * write -- and every agent runs as `node`, which owns /app. So this is run
 * ONCE, at image build time (Dockerfile build stage), and its output is copied
 * to the root-owned /usr/local/share/paperclip/server-secret-names. At
 * container start the root-owned scripts/server-secrets-handoff.sh reads that
 * file; no Node code, no tsx and no node_modules lookup ever run as root.
 *
 * Output, one entry per line:
 *
 *   name <EXACT_NAME>
 *   prefix <PREFIX>          (any name starting with it is a server key)
 *
 * The names come from the single list in
 * @paperclipai/adapter-utils/server-env-secrets, so there is still exactly one
 * place that decides what counts as a server key.
 */
import { pathToFileURL } from "node:url";
import {
  SERVER_DATABASE_ENV_NAMES,
  SERVER_ONLY_ENV_NAMES,
  SERVER_ONLY_ENV_PREFIXES,
} from "@paperclipai/adapter-utils/server-env-secrets";

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function formatServerSecretNameList(): string {
  const names = [...new Set([...SERVER_ONLY_ENV_NAMES, ...SERVER_DATABASE_ENV_NAMES])].sort();
  const prefixes = [...new Set(SERVER_ONLY_ENV_PREFIXES)].sort();
  for (const entry of [...names, ...prefixes]) {
    // The shell side only accepts plain variable names; refuse to build an
    // image whose list it would silently skip.
    if (!SHELL_NAME.test(entry)) throw new Error(`server key name is not a plain variable name: ${entry}`);
  }
  const lines = [...names.map((name) => `name ${name}`), ...prefixes.map((prefix) => `prefix ${prefix}`)];
  return `${lines.join("\n")}\n`;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.stdout.write(formatServerSecretNameList());
}

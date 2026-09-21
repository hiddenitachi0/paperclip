import { stripServerSecrets } from "@paperclipai/adapter-utils/server-utils";

export { stripServerSecrets };

/**
 * DUR-3994: a copy of the server's environment with its own keys removed, for
 * commands the server runs itself inside folders agents control (git in an
 * agent's checkout runs that checkout's hooks and core.fsmonitor with this
 * env). Everything else is kept, exactly as an implicit inherit would.
 */
export function serverChildProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return stripServerSecrets({ ...process.env, ...extra });
}

/**
 * Standalone module (no dependency on workspace-runtime.ts) so callers that
 * only need to sanitize a spawned child process's environment -- like the
 * board-chat route -- don't have to import the entire execution-workspace /
 * runtime-service module graph just to reach this one pure function.
 */
export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  delete env.DATABASE_MIGRATION_URL;
  delete env.DATABASE_BYPASS_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  // DUR-3994: BETTER_AUTH_SECRET and the server's other keys don't start with
  // PAPERCLIP_, so the loop above never removed them.
  stripServerSecrets(env);
  return env;
}

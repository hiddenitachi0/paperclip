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
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}

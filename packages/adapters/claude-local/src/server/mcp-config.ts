import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

export interface ClaudeMcpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Reads the agent's Paperclip-managed adapterConfig.mcpServers value (already
// a parsed JS array, not a JSON string) into well-formed entries. Malformed
// entries are dropped rather than failing the whole run; callers should log
// how many were dropped.
export function parseClaudeMcpServersConfig(raw: unknown): {
  servers: ClaudeMcpServerConfig[];
  skippedCount: number;
} {
  if (!Array.isArray(raw)) return { servers: [], skippedCount: 0 };
  const servers: ClaudeMcpServerConfig[] = [];
  let skippedCount = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      skippedCount += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!name || (!command && !url)) {
      skippedCount += 1;
      continue;
    }
    const server: ClaudeMcpServerConfig = { name };
    if (command) {
      server.command = command;
      if (Array.isArray(record.args)) {
        const args = record.args.filter((item): item is string => typeof item === "string");
        if (args.length > 0) server.args = args;
      }
      if (typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)) {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
          if (typeof value === "string") env[key] = value;
        }
        if (Object.keys(env).length > 0) server.env = env;
      }
    } else {
      server.url = url;
      if (typeof record.headers === "object" && record.headers !== null && !Array.isArray(record.headers)) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(record.headers as Record<string, unknown>)) {
          if (typeof value === "string") headers[key] = value;
        }
        if (Object.keys(headers).length > 0) server.headers = headers;
      }
    }
    servers.push(server);
  }
  return { servers, skippedCount };
}

// Claude CLI's --mcp-config file format: { "mcpServers": { "<name>": {...} } }.
// Remote/http servers use { "type": "http" | "sse", "url": ..., "headers": ... }.
export function buildClaudeMcpConfigFileContents(servers: ClaudeMcpServerConfig[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.command) {
      mcpServers[server.name] = {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
      };
    } else if (server.url) {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

function resolveManagedClaudeMcpConfigRoot(env: NodeJS.ProcessEnv, companyId: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.resolve(instanceRoot, "companies", companyId, "claude-mcp-config");
}

// Materializes the agent's configured MCP servers to a content-addressed JSON
// file under a per-agent managed directory, suitable for both local use
// (pass the returned filePath straight to --mcp-config) and remote/sandbox
// use (sync the returned dir via the same asset-sync mechanism used for the
// skills/config-seed bundles, then reference the synced dir's file).
export async function prepareClaudeMcpConfigSeed(input: {
  companyId: string;
  agentId: string;
  servers: ClaudeMcpServerConfig[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ dir: string; filePath: string } | null> {
  if (input.servers.length === 0) return null;

  const contents = buildClaudeMcpConfigFileContents(input.servers);
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 16);
  const dir = path.join(
    resolveManagedClaudeMcpConfigRoot(process.env, input.companyId),
    input.agentId,
    hash,
  );
  const filePath = path.join(dir, "mcp-config.json");

  const exists = await fs.access(filePath).then(() => true).catch(() => false);
  if (!exists) {
    await fs.mkdir(dir, { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, contents, "utf8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      const nowExists = await fs.access(filePath).then(() => true).catch(() => false);
      if (!nowExists) throw error;
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }
    await input.onLog(
      "stdout",
      `[paperclip] Prepared per-agent MCP server config (${input.servers.length} server${input.servers.length === 1 ? "" : "s"}: ${input.servers.map((s) => s.name).join(", ")}) at "${filePath}".\n`,
    );
  }

  return { dir, filePath };
}

import { z } from "zod";
import { mcpServerConfigSchema, type McpServerConfig } from "./agent.js";

// DUR-143: the "tool library" -- add an MCP server once in Settings (name,
// structured connection info, credential picked from the Secrets UI) and
// assign it to any agent with a checkbox, exactly like the existing Skills
// flow. No raw JSON in this primary path; the advanced JSON editor
// (mcpServerConfigSchema / adapterConfig.mcpServers, see validators/agent.ts)
// keeps working unchanged as an escape hatch.
//
// Hard rule: a tool-library credential is ALWAYS a secret_ref. Unlike
// adapterConfig.env / mcpServers[*].env (which accept plain values too, for
// backward compatibility with the advanced path), `companyMcpToolCredentialSchema`
// has no "plain value" variant at all -- so it is impossible to construct a
// valid tool-library credential that isn't a reference to a secret the
// operator entered through the Secrets UI.

export const companyMcpToolCredentialSchema = z.object({
  // Which part of the resulting MCP server config this credential lands in --
  // most servers take an API key via env; some remote (http/sse) servers take
  // it via a header instead (e.g. `Authorization: Bearer ...`).
  field: z.enum(["env", "headers"]).default("env"),
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Must be a valid environment/header key name"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});

export type CompanyMcpToolCredential = z.infer<typeof companyMcpToolCredentialSchema>;

export const companyMcpToolConnectionSchema = z
  .object({
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(500)).max(50).optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    credentials: z.array(companyMcpToolCredentialSchema).max(20).optional().default([]),
  })
  .superRefine((value, ctx) => {
    const hasCommand = typeof value.command === "string" && value.command.length > 0;
    const hasUrl = typeof value.url === "string" && value.url.length > 0;
    if (hasCommand === hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set exactly one of command (runs locally) or url (remote server)",
        path: ["command"],
      });
    }
    const seen = new Set<string>();
    value.credentials.forEach((cred, index) => {
      const dedupeKey = `${cred.field}:${cred.key}`;
      if (seen.has(dedupeKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate credential key: ${cred.key}`,
          path: ["credentials", index, "key"],
        });
      }
      seen.add(dedupeKey);
    });
  });

export type CompanyMcpToolConnection = z.infer<typeof companyMcpToolConnectionSchema>;

const mcpToolName = z.string().trim().min(1).max(120);
// The one-line human description shown at assignment time ("makes images",
// "reads our calendar") -- required, not optional, since the ticket calls
// for every tool to carry one.
const mcpToolDescription = z.string().trim().min(1).max(240);

export const companyMcpToolCreateSchema = z.object({
  name: mcpToolName,
  description: mcpToolDescription,
  connection: companyMcpToolConnectionSchema,
  catalogKey: z.string().trim().min(1).max(80).optional().nullable(),
});

export type CompanyMcpToolCreate = z.infer<typeof companyMcpToolCreateSchema>;

export const companyMcpToolUpdateSchema = z.object({
  name: mcpToolName.optional(),
  description: mcpToolDescription.optional(),
  connection: companyMcpToolConnectionSchema.optional(),
});

export type CompanyMcpToolUpdate = z.infer<typeof companyMcpToolUpdateSchema>;

// POST body for "install from catalog" (the Fal.ai one-click path): pick the
// template by key and bind each of its required credential placeholders to a
// secret. `credentialSecretIds` values are always secret ids, never values.
export const mcpToolCatalogInstallSchema = z.object({
  catalogKey: z.string().trim().min(1).max(80),
  credentialSecretIds: z.record(z.string().trim().min(1), z.string().uuid()).default({}),
  name: mcpToolName.optional(),
  description: mcpToolDescription.optional(),
});

export type McpToolCatalogInstall = z.infer<typeof mcpToolCatalogInstallSchema>;

export const companyMcpToolSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  connection: companyMcpToolConnectionSchema,
  catalogKey: z.string().nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});

export type CompanyMcpTool = z.infer<typeof companyMcpToolSchema>;

// One entry in the built-in catalog (Settings' "quick add" list). Purely
// descriptive/template data -- never carries a secret itself.
export const mcpToolCatalogEntrySchema = z.object({
  catalogKey: z.string(),
  name: z.string(),
  description: z.string(),
  homepageUrl: z.string().nullable().optional(),
  connectionTemplate: z.object({
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
  }),
  requiredCredentials: z.array(
    z.object({
      field: z.enum(["env", "headers"]),
      key: z.string(),
      label: z.string(),
    }),
  ),
});

export type McpToolCatalogEntry = z.infer<typeof mcpToolCatalogEntrySchema>;

// GET /agents/:agentId/mcp-tools item: a library tool plus whether this
// particular agent currently has it checked.
export const agentMcpToolListItemSchema = companyMcpToolSchema.extend({
  assigned: z.boolean(),
});

export type AgentMcpToolListItem = z.infer<typeof agentMcpToolListItemSchema>;

// Deterministically converts a stored tool-library connection into the same
// mcpServerConfigSchema shape the advanced raw-JSON editor writes directly.
// This is the one place the two paths meet: once built, a library-derived
// entry is byte-for-byte indistinguishable (at the schema level) from one an
// operator would have hand-typed, so no separate runtime resolution code is
// needed -- it flows through the existing DUR-132
// resolveAdapterConfigForRuntime unchanged.
export function buildMcpServerConfigFromTool(tool: {
  key: string;
  connection: CompanyMcpToolConnection;
}): McpServerConfig {
  const env: Record<string, { type: "secret_ref"; secretId: string; version?: "latest" | number }> = {};
  const headers: Record<string, { type: "secret_ref"; secretId: string; version?: "latest" | number }> = {};

  for (const credential of tool.connection.credentials) {
    const target = credential.field === "headers" ? headers : env;
    target[credential.key] = {
      type: "secret_ref",
      secretId: credential.secretId,
      ...(credential.version !== undefined ? { version: credential.version } : {}),
    };
  }

  const entry: Record<string, unknown> = {
    name: tool.key,
    transport: tool.connection.transport,
    command: tool.connection.command,
    args: tool.connection.args,
    url: tool.connection.url,
  };
  if (Object.keys(env).length > 0) entry.env = env;
  if (Object.keys(headers).length > 0) entry.headers = headers;
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key];
  }

  return mcpServerConfigSchema.parse(entry);
}

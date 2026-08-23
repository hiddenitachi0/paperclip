// DUR-143: the "tool library" — an MCP server added once in Settings (name,
// human description, connection config) that then shows up as a named,
// checkbox-assignable entry on every agent. See company_mcp_tools schema and
// mcp-tool-library.ts validators for the shape.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMcpTools } from "@paperclipai/db";
import { envBindingSchema, type SecretVersionSelector } from "@paperclipai/shared";
import type { McpToolLibraryConnection } from "@paperclipai/shared/validators/mcp-tool-library";
import { notFound } from "../errors.js";

// Same charset agent-secret-bindings.ts requires of an MCP server's `name` —
// this is what a library entry's `key` is used as at dispatch time, so it
// must already satisfy that constraint (server names key the binding
// configPath: `mcpServers[<key>]...`).
const MCP_TOOL_KEY_RE = /^[a-z0-9-]{1,64}$/;

function deriveKey(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return MCP_TOOL_KEY_RE.test(slug) && slug.length > 0 ? slug : "tool";
}

export interface McpToolLibraryEntryInput {
  name: string;
  description: string;
  connection: McpToolLibraryConnection;
}

export async function createMcpTool(db: Db, companyId: string, input: McpToolLibraryEntryInput) {
  const key = deriveKey(input.name);
  const existing = await db
    .select({ id: companyMcpTools.id })
    .from(companyMcpTools)
    .where(and(eq(companyMcpTools.companyId, companyId), eq(companyMcpTools.key, key)));
  const finalKey = existing.length > 0 ? `${key}-${Date.now().toString(36)}` : key;

  const [created] = await db
    .insert(companyMcpTools)
    .values({
      companyId,
      name: input.name,
      key: finalKey,
      description: input.description,
      connection: input.connection,
    })
    .returning();
  return created!;
}

export async function listMcpTools(db: Db, companyId: string) {
  return db
    .select()
    .from(companyMcpTools)
    .where(eq(companyMcpTools.companyId, companyId))
    .orderBy(companyMcpTools.name);
}

export async function getMcpTool(db: Db, toolId: string) {
  const [row] = await db.select().from(companyMcpTools).where(eq(companyMcpTools.id, toolId));
  return row ?? null;
}

export async function updateMcpTool(
  db: Db,
  toolId: string,
  input: Partial<McpToolLibraryEntryInput>,
) {
  const updates: Partial<typeof companyMcpTools.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) {
    updates.name = input.name;
    const candidateKey = deriveKey(input.name);
    const current = await db
      .select({ companyId: companyMcpTools.companyId, key: companyMcpTools.key })
      .from(companyMcpTools)
      .where(eq(companyMcpTools.id, toolId))
      .then((rows) => rows[0] ?? null);
    if (current) {
      const collision = await db
        .select({ id: companyMcpTools.id })
        .from(companyMcpTools)
        .where(
          and(
            eq(companyMcpTools.companyId, current.companyId),
            eq(companyMcpTools.key, candidateKey),
          ),
        );
      const collidingOther = collision.filter((r) => r.id !== toolId);
      updates.key = collidingOther.length === 0 ? candidateKey : current.key;
    }
  }
  if (input.description !== undefined) updates.description = input.description;
  if (input.connection !== undefined) updates.connection = input.connection;

  const [updated] = await db
    .update(companyMcpTools)
    .set(updates)
    .where(eq(companyMcpTools.id, toolId))
    .returning();
  if (!updated) throw notFound("Tool not found");
  return updated;
}

export async function deleteMcpTool(db: Db, toolId: string) {
  await db.delete(companyMcpTools).where(eq(companyMcpTools.id, toolId));
}

// Live checkbox state for the agent's assignment UI: every tool in the
// company's library, each flagged with whether this agent currently has it.
export async function listMcpToolsForAgent(db: Db, companyId: string, selectedToolIds: string[]) {
  const tools = await listMcpTools(db, companyId);
  const selected = new Set(selectedToolIds);
  return tools.map((tool) => ({ ...tool, enabled: selected.has(tool.id) }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

interface CollectedSecretRef {
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
}

// Secret refs carried by the tools this agent has checked, in the same
// `mcpServers[<name>].env.<KEY>` / `.headers.<KEY>` configPath shape
// agent-secret-bindings.ts uses for the agent's own explicit mcpServers —
// so assertBindingContext authorizes resolution the same way regardless of
// whether the server came from the agent's own adapterConfig or a granted
// tool. Unknown/deleted tool ids are silently skipped.
export async function collectMcpToolLibrarySecretRefs(
  db: Db,
  companyId: string,
  toolIds: string[],
): Promise<CollectedSecretRef[]> {
  if (toolIds.length === 0) return [];
  const rows = await db
    .select()
    .from(companyMcpTools)
    .where(and(eq(companyMcpTools.companyId, companyId), inArray(companyMcpTools.id, toolIds)));

  const refs: CollectedSecretRef[] = [];
  for (const row of rows) {
    const connection = asRecord(row.connection) ?? {};
    for (const field of ["env", "headers"] as const) {
      const fieldValue = asRecord(connection[field]);
      if (!fieldValue) continue;
      for (const [key, rawBinding] of Object.entries(fieldValue)) {
        const parsed = envBindingSchema.safeParse(rawBinding);
        if (!parsed.success) continue;
        const binding = parsed.data;
        if (typeof binding !== "object" || binding === null || binding.type !== "secret_ref") continue;
        refs.push({
          secretId: binding.secretId,
          configPath: `mcpServers[${row.key}].${field}.${key}`,
          versionSelector: binding.version ?? "latest",
        });
      }
    }
  }
  return refs;
}

// The actual mcpServerConfig-shaped entries for this agent's granted tools,
// ready to concatenate into adapterConfig.mcpServers before secret
// resolution at dispatch. Entries whose key collides with a name already
// present in `existingServerNames` are dropped — the agent's own explicit
// config always wins, matching the company_agent_roles merge precedent.
export async function resolveAgentMcpToolLibraryServers(
  db: Db,
  companyId: string,
  toolIds: string[],
  existingServerNames: Set<string> = new Set(),
): Promise<Array<Record<string, unknown>>> {
  if (toolIds.length === 0) return [];
  const rows = await db
    .select()
    .from(companyMcpTools)
    .where(and(eq(companyMcpTools.companyId, companyId), inArray(companyMcpTools.id, toolIds)));

  return rows
    .filter((row) => !existingServerNames.has(row.key))
    .map((row) => ({ name: row.key, ...(asRecord(row.connection) ?? {}) }));
}

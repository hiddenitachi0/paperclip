import { z } from "zod";
import { envBindingSchema } from "./secret.js";

// DUR-143: the tool library's connection shape is mcpServerConfigSchema
// (agent.ts) minus `name` — the library entry's own `key` (a server-derived
// slug, never typed by a human) fills that role at dispatch time so the
// human-facing `name` can be free text ("Fal.ai") without colliding with the
// `[A-Za-z0-9_-]{1,64}` charset an MCP server name must satisfy.
export const mcpToolLibraryConnectionSchema = z
  .object({
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), envBindingSchema).optional(),
    url: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), envBindingSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCommand = typeof value.command === "string" && value.command.length > 0;
    const hasUrl = typeof value.url === "string" && value.url.length > 0;
    if (hasCommand === hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Set exactly one of: runs a command, or connects to a URL.",
        path: ["command"],
      });
    }
  });

export type McpToolLibraryConnection = z.infer<typeof mcpToolLibraryConnectionSchema>;

export const mcpToolLibraryEntryBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(280),
    connection: mcpToolLibraryConnectionSchema,
  })
  .strict();

export type McpToolLibraryEntryBody = z.infer<typeof mcpToolLibraryEntryBodySchema>;

export const mcpToolLibraryEntryUpdateSchema = mcpToolLibraryEntryBodySchema.partial();

export type McpToolLibraryEntryUpdate = z.infer<typeof mcpToolLibraryEntryUpdateSchema>;

export const agentMcpToolSelectionSchema = z
  .object({
    desiredToolIds: z.array(z.string().uuid()).max(200),
  })
  .strict();

export type AgentMcpToolSelection = z.infer<typeof agentMcpToolSelectionSchema>;

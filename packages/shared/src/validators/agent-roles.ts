import { z } from "zod";
import { PERMISSION_KEYS } from "../constants.js";
import { mcpServersConfigSchema } from "./agent.js";

// DUR-114: default permission grants a role carries. Restricted to the
// existing PERMISSION_KEYS enum -- which has no deploy/merge-approval key --
// so a role can never, even by construction, carry the power to approve a
// deploy. `assertBoard` on the approve/reject endpoints is untouched.
export const agentRolePermissionGrantSchema = z.object({
  permissionKey: z.enum(PERMISSION_KEYS),
  scope: z.record(z.string(), z.unknown()).nullable().optional().default(null),
});

export type AgentRolePermissionGrant = z.infer<typeof agentRolePermissionGrantSchema>;

export const createAgentRoleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  defaultInstructions: z.string().max(200_000).optional().nullable(),
  defaultMcpServers: mcpServersConfigSchema.optional().default([]),
  defaultPermissionGrants: z.array(agentRolePermissionGrantSchema).max(PERMISSION_KEYS.length).optional().default([]),
});

export type CreateAgentRole = z.infer<typeof createAgentRoleSchema>;

export const updateAgentRoleSchema = createAgentRoleSchema.partial();

export type UpdateAgentRole = z.infer<typeof updateAgentRoleSchema>;

export const duplicateAgentRoleSchema = z.object({
  targetCompanyId: z.string().uuid(),
});

export type DuplicateAgentRole = z.infer<typeof duplicateAgentRoleSchema>;

// POST /agents/:id/role -- board-only. `roleId: null` unassigns the agent's
// current role without reverting any previously-applied defaults (no
// reconciliation model, see agent-roles.ts service).
export const assignAgentRoleSchema = z.object({
  roleId: z.string().uuid().nullable(),
});

export type AssignAgentRole = z.infer<typeof assignAgentRoleSchema>;

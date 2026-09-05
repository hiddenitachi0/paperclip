import { api } from "./client";

// DUR-143: connection mirrors mcpServerConfigSchema minus `name` — the
// library entry's own server-derived `key` fills that role at dispatch time.
// env/headers values are always a secret_ref — the tool library never
// accepts a plain credential value (that's what the raw JSON adapterConfig
// editor is for).
export interface McpToolConnectionBinding {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
}

export interface McpToolConnection {
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, McpToolConnectionBinding>;
  url?: string;
  headers?: Record<string, McpToolConnectionBinding>;
}

export interface McpToolLibraryEntry {
  id: string;
  companyId: string;
  name: string;
  key: string;
  description: string;
  connection: McpToolConnection;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMcpToolListItem extends McpToolLibraryEntry {
  enabled: boolean;
}

export interface McpToolLibraryEntryInput {
  name: string;
  description: string;
  connection: McpToolConnection;
}

export const mcpToolLibraryApi = {
  list: (companyId: string) => api.get<McpToolLibraryEntry[]>(`/companies/${companyId}/mcp-tools`),
  create: (companyId: string, data: McpToolLibraryEntryInput) =>
    api.post<McpToolLibraryEntry>(`/companies/${companyId}/mcp-tools`, data),
  update: (toolId: string, data: Partial<McpToolLibraryEntryInput>) =>
    api.patch<McpToolLibraryEntry>(`/mcp-tools/${toolId}`, data),
  remove: (toolId: string) => api.delete<void>(`/mcp-tools/${toolId}`),
  listForAgent: (agentId: string) => api.get<AgentMcpToolListItem[]>(`/agents/${agentId}/mcp-tools`),
  syncAgentSelection: (agentId: string, desiredToolIds: string[]) =>
    api.post<{ id: string; mcpToolIds: string[] }>(`/agents/${agentId}/mcp-tools/sync`, {
      desiredToolIds,
    }),
};

// DUR-3909: "Connect & sign in" — for tools whose server needs an interactive
// browser OAuth handshake instead of a pasted key. start() opens a session
// and returns a third-party authorizeUrl to pop open; status() is polled
// until the operator finishes (or abandons) that browser flow.
export interface McpOAuthSession {
  id: string;
  toolId: string;
  status: "pending" | "completed" | "failed";
  errorMessage: string | null;
  resultSecretId: string | null;
}

export const mcpOAuthApi = {
  start: (toolId: string) =>
    api.post<{ sessionId: string; authorizeUrl: string }>(`/mcp-tools/${toolId}/oauth/start`, {}),
  status: (toolId: string, sessionId: string) =>
    api.get<McpOAuthSession>(`/mcp-tools/${toolId}/oauth/sessions/${sessionId}`),
};

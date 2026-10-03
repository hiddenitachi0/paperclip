import { z } from "zod";

// Quick-agent memory notebook: short notes a quick agent was asked to
// remember, which the operator can also read, add, edit and delete on the
// agent's page. A note belongs to the agent's persona (the person) when it
// has one, else to the agent (the job).

/** Longest note, in characters. The database checks the same bound. */
export const AGENT_MEMORY_MAX_LENGTH = 500;
/** Most notes one owner (a persona, or an agent without one) can hold. */
export const AGENT_MEMORY_MAX_NOTES = 100;

export const AGENT_MEMORY_SOURCES = ["agent", "user"] as const;
export type AgentMemorySource = (typeof AGENT_MEMORY_SOURCES)[number];

/** Collapses runs of whitespace and trims, so "  a \n b " is saved as "a b". */
export function normalizeAgentMemoryText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const noteTextSchema = z
  .string()
  .transform(normalizeAgentMemoryText)
  .pipe(
    z
      .string()
      .min(1, "Write something to remember.")
      .max(AGENT_MEMORY_MAX_LENGTH, `A note can be at most ${AGENT_MEMORY_MAX_LENGTH} characters.`),
  );

export const createAgentMemorySchema = z.object({ text: noteTextSchema }).strict();
export const updateAgentMemorySchema = z.object({ text: noteTextSchema }).strict();
export type CreateAgentMemory = z.infer<typeof createAgentMemorySchema>;
export type UpdateAgentMemory = z.infer<typeof updateAgentMemorySchema>;

export interface AgentMemoryNote {
  id: string;
  text: string;
  source: AgentMemorySource;
  /** The agent the note was added through. */
  agentId: string;
  personaId: string | null;
  createdByUserId: string | null;
  /** The person's name when known, for "added by ..." on the page. */
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemoryList {
  /** Whose notebook this is: the person attached to the agent, or the agent itself. */
  owner: { kind: "persona"; personaId: string; name: string | null } | { kind: "agent"; agentId: string; name: string };
  maxNotes: number;
  maxLength: number;
  /** Newest first. */
  notes: AgentMemoryNote[];
}

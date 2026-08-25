import type { IssueComment } from "@paperclipai/shared";

/**
 * Simple mode (DUR-212): a text box that turns into a normal Paperclip issue
 * behind the scenes. These helpers keep that translation — and the
 * reverse translation back into plain language for the reply — out of the
 * page component so they can be unit tested without rendering React.
 */

const TITLE_MAX_LENGTH = 80;

/** First line of the request, trimmed to a title. Falls back to the raw text. */
export function buildSimpleModeTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  const source = firstLine || text.trim();
  if (source.length <= TITLE_MAX_LENGTH) return source;
  return `${source.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

const CLOSED_FOR_SIMPLE_MODE = new Set<string>([
  "done",
  "cancelled",
  "blocked",
  "in_review",
]);

/** Whether the issue has settled into a state simple mode should stop polling on. */
export function isSimpleModeSettled(status: string): boolean {
  return CLOSED_FOR_SIMPLE_MODE.has(status);
}

type AssigneeCandidate = { id: string; role: string; status: string };

const UNAVAILABLE_AGENT_STATUSES = new Set(["terminated", "paused", "error"]);

/**
 * Pick who a simple-mode request should land on. The person never chooses an
 * agent, so default to the company's CEO (the generalist, company-facing
 * role) — the same default the board concierge chat uses — and only fall
 * back to "whoever is available" if there is no CEO.
 */
export function selectSimpleModeAssignee<T extends AssigneeCandidate>(
  agents: T[] | null | undefined,
): T | null {
  if (!agents || agents.length === 0) return null;
  const available = agents.filter((a) => !UNAVAILABLE_AGENT_STATUSES.has(a.status));
  const ceo = available.find((a) => a.role === "ceo");
  if (ceo) return ceo;
  return available[0] ?? agents[0] ?? null;
}

export function buildSimpleModeIssuePayload(input: {
  text: string;
  assigneeAgentId: string;
}): Record<string, unknown> {
  const description = input.text.trim();
  return {
    title: buildSimpleModeTitle(description),
    description,
    assigneeAgentId: input.assigneeAgentId,
    status: "todo" as const,
    priority: "medium" as const,
  };
}

// Redact the kinds of references a non-technical reader should never have to
// parse: issue IDs (DUR-123), PR mentions (PR #12, #12), and commit hashes.
// Best-effort — this trims what the default reply is likely to contain, it
// does not guarantee an agent's free-text reply is fully sanitized.
const TICKET_ID_RE = /\b[A-Z]{2,8}-\d+\b/g;
const PR_REF_RE = /\b(?:PR|pull request)\s*#\d+\b/gi;
const BARE_HASH_REF_RE = /(?<![\w/])#\d+\b/g;
const COMMIT_PHRASE_RE = /\bcommit\s+[0-9a-f]{7,40}\b/gi;
const LONG_HEX_RE = /\b[0-9a-f]{12,40}\b/gi;

export function sanitizeSimpleModeText(text: string): string {
  return text
    .replace(COMMIT_PHRASE_RE, "the latest change")
    .replace(LONG_HEX_RE, "")
    .replace(PR_REF_RE, "")
    .replace(TICKET_ID_RE, "")
    .replace(BARE_HASH_REF_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

type SimpleModeComment = {
  authorType: IssueComment["authorType"];
  body: string;
  createdAt: string | Date;
  deletedAt?: string | Date | null;
};

/** The most recent non-deleted agent reply, newest first — the plain-language answer. */
export function findLatestSimpleModeReply<T extends SimpleModeComment>(
  comments: T[] | null | undefined,
): T | null {
  if (!comments || comments.length === 0) return null;
  const replies = comments
    .filter((c) => c.authorType === "agent" && !c.deletedAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return replies[0] ?? null;
}

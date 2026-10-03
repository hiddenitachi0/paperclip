/**
 * Research and plan tasks: the few names the server, the screens and the
 * Telegram bridge share.
 *
 * A quick agent hands a research or planning request ("plan a trip", "find the
 * best price on X") to a full run as a task for itself. The full run follows
 * the bundled `research-and-plan` skill and delivers one issue document with
 * the key RESEARCH_RESULT_DOCUMENT_KEY (the "result page") plus a short
 * closing comment; the chat that asked gets that comment and a link to the
 * page.
 */

/** The issue document a research task delivers its result page in. */
export const RESEARCH_RESULT_DOCUMENT_KEY = "result" as const;
/** The bundled skill (skills/research-and-plan) the full run follows. */
export const RESEARCH_SKILL_SLUG = "research-and-plan" as const;
/** Its canonical company-skill key once bundled into a company. */
export const RESEARCH_SKILL_KEY = `paperclipai/paperclip/${RESEARCH_SKILL_SLUG}` as const;

export const RESEARCH_TASK_KINDS = ["trip_plan", "price_hunt", "research"] as const;
export type ResearchTaskKind = (typeof RESEARCH_TASK_KINDS)[number];

/** A task a quick agent started while answering a message (route_to_agent or start_research_task). */
export interface ChatHandedOverTask {
  issueId: string;
  identifier: string | null;
  title: string;
}

/** The in-app path of a task's result page: `/issues/<ref>#document-result`. */
export function researchResultPagePath(issueRef: string): string {
  return `/issues/${issueRef}#document-${RESEARCH_RESULT_DOCUMENT_KEY}`;
}

import { SafeOutboundFetchError } from "../safe-outbound-fetch.js";
import type { PaperlessReadContext } from "./connection-kind.js";

/**
 * DUR-4302: the "Test" button for a paperless-ngx connection. Confirms two
 * things, in order: the container is reachable at all (through the pinned
 * internal transport), and the stored API token is accepted by it. Never
 * reads or lists any document -- Phase 1 has no agent tool yet, and Test
 * should not itself be a way to browse a company's documents.
 */

const CONNECTION_CHECK_PATH = "/api/documents/?page_size=1";

export interface PaperlessCheckResult {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/** Plain sentence for anything the pinned transport or fetch throws. Never an unknown error's text. */
export function paperlessProblem(error: unknown): string {
  if (error instanceof SafeOutboundFetchError) return error.message;
  return "Could not reach the paperless-ngx container. The error is logged.";
}

export async function runPaperlessConnectionCheck(context: PaperlessReadContext): Promise<PaperlessCheckResult> {
  const problems: string[] = [];
  const notes: string[] = [];
  let ok = false;
  try {
    const response = await context.fetch(`${context.baseUrl}${CONNECTION_CHECK_PATH}`, { method: "GET" });
    if (response.status === 401 || response.status === 403) {
      problems.push("The stored API token was not accepted by this company's paperless-ngx container. Paste it in again.");
    } else if (response.status >= 200 && response.status < 300) {
      ok = true;
      notes.push("The container answered and the stored API token was accepted.");
    } else {
      problems.push(`The container answered with an unexpected status (${response.status}).`);
    }
  } catch (error) {
    problems.push(paperlessProblem(error));
  }
  return { ok, problems, notes };
}

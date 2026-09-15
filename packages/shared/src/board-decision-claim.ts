/**
 * Agents have no authority to decide approvals, but they sometimes post a
 * comment that reads like one ("## Board Decision: APPROVED" on NOR-1437,
 * posted by the CEO agent while the real deploy approval was still pending).
 *
 * This is the single test for "this comment claims a board decision". The
 * server uses it to record an activity row for an agent-authored comment, and
 * the issue thread uses it to show a small marker on that comment, so both
 * surfaces always agree about which comments are flagged.
 *
 * Deliberately narrow (a false flag teaches the operator to ignore it): the
 * claim must START a line (after heading/list/bold markup) and carry an actual
 * decision word. "Waiting for the board decision", "Board decision: pending",
 * "Board decision needed" and "Board decision: approved or rejected?" are not
 * flagged.
 */

/** Activity action recorded when an agent-authored comment claims a board decision. */
export const AGENT_BOARD_DECISION_CLAIM_ACTION = "issue.agent_board_decision_claim_flagged";

/** Marker shown on such a comment in the issue thread. Plain words for the operator. */
export const AGENT_BOARD_DECISION_CLAIM_NOTICE =
  "This message reads like a decision on an approval, but agents cannot make that decision. " +
  "Only you can, on the approval card itself.";

export type BoardDecisionClaimOutcome = "approved" | "rejected";

export interface BoardDecisionClaim {
  outcome: BoardDecisionClaimOutcome;
  /** The line that made the claim, trimmed and capped for activity details. */
  line: string;
}

const CLAIM_SUBJECT =
  "(?:the\\s+)?board(?:'s)?\\s+decision|styrevedtak(?:et)?|styrets\\s+(?:vedtak|beslutning)";

const APPROVED_WORDS = ["approved", "godkjent", "innvilget", "vedtatt"];
const REJECTED_WORDS = ["rejected", "denied", "declined", "avvist", "avslått", "avslatt"];
const DECISION_WORD = `(${[...APPROVED_WORDS, ...REJECTED_WORDS].join("|")})`;

// Leading markdown a heading/list/bold line may carry before the words.
const LEADING_MARKUP = "^[\\s#>*_`\\-+]*";
// Optional "(DUR-29)"-style aside and separator between subject and decision.
const SEPARATOR = "[\\s*_`]*(?:\\([^)]{0,40}\\))?[\\s*_`]*(?:[:=\\-\\u2013\\u2014]|\\bis\\b|\\ber\\b)?[\\s*_`]*";
// Not "approved or rejected" / "godkjent eller avvist" / "approved/rejected".
const NOT_A_CHOICE = "(?![\\p{L}\\p{N}])(?!\\s*(?:or|eller)\\b)(?!\\s*\\/)";

const SAME_LINE_CLAIM = new RegExp(`${LEADING_MARKUP}(?:${CLAIM_SUBJECT})${SEPARATOR}${DECISION_WORD}${NOT_A_CHOICE}`, "iu");
const HEADING_ONLY = new RegExp(`^\\s*#{1,6}\\s*[*_]*\\s*(?:${CLAIM_SUBJECT})\\s*[*_:]*\\s*$`, "iu");
const DECISION_LINE = new RegExp(`${LEADING_MARKUP}${DECISION_WORD}${NOT_A_CHOICE}`, "iu");

function outcomeFor(word: string): BoardDecisionClaimOutcome {
  return APPROVED_WORDS.includes(word.toLowerCase()) ? "approved" : "rejected";
}

function capLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

export function detectBoardDecisionClaim(body: string | null | undefined): BoardDecisionClaim | null {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const sameLine = SAME_LINE_CLAIM.exec(line);
    if (sameLine?.[1]) {
      return { outcome: outcomeFor(sameLine[1]), line: capLine(line) };
    }

    // "## Board Decision" heading with the decision on the next non-empty line.
    if (HEADING_ONLY.test(line)) {
      let next = index + 1;
      while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
      const decisionLine = lines[next] ?? "";
      const decision = DECISION_LINE.exec(decisionLine);
      if (decision?.[1]) {
        return { outcome: outcomeFor(decision[1]), line: capLine(`${line.trim()} ${decisionLine.trim()}`) };
      }
    }
  }
  return null;
}

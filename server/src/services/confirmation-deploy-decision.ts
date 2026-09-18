/**
 * DUR-3990: a confirmation card must not ask the operator to approve a deploy.
 *
 * On 18 Sep an agent filed a confirmation card asking "Approve deployment of the NOR-1485
 * fix (commit 0ce2e87) to production?". On that board a deploy only ever happens through a
 * deploy approval, which the deploy runner acts on; a confirmation card cannot deploy
 * anything. So the operator was asked a question where "yes" does nothing -- and the commit
 * named was not in the shared repository either (DUR-3987).
 *
 * DUR-3979 already refuses a confirmation card that names an EXISTING approval. This card
 * named none: it asked for a deploy decision that had no approval behind it, so that guard
 * never applied. This closes that hole.
 *
 * Detection is deliberately a wording heuristic on the card's own question, and deliberately
 * one-directional. The DUR-320/DUR-323 warning on requestConfirmationPayloadSchema.factCheck
 * -- do not infer a card's meaning from its wording -- is about wording GRANTING something,
 * where a rewording that defeats the keywords is a privilege escalation. Here wording only
 * ever REFUSES: an agent that rewords its way past these patterns is back to today's
 * behaviour, which is the failure this ticket accepts. DUR-3990 states the trade directly --
 * a false refusal is cheap (the agent rephrases, and the message says how), a deploy card
 * the operator cannot act on is not.
 *
 * Only the question itself is read, never the details body: a card that mentions a past
 * deploy while asking about something else must go through, and details are where that
 * mention usually lives.
 */

/**
 * Asking the operator for permission, rather than for information.
 *
 * Norwegian as well as English on purpose: the operator reads Norwegian, so the agents
 * writing to him write Norwegian, and an English-only check would miss most real cards on
 * the board where this went wrong.
 */
const PERMISSION_ASK =
  /\b(approve|approves|approval|approving|go ahead|green ?light|shall i|should i|can i|may i|ok to|okay to|permission to|sign off|sign-off|authorise|authorize|proceed with)\b|\b(godkjenn|godkjenne|godkjenner|godkjenning|kan jeg|skal jeg|kan vi|skal vi|er det greit|er det ok|klarsignal|tillatelse til|g(?:å|a) videre med)\b/i;

/**
 * A deploy/merge action still to happen. Past-tense forms ("deployed", "shipped",
 * "released", "merged", "rolled out", "deployet", "publisert", "lansert") deliberately do
 * not match -- a card reporting work that already went out and asking about something else
 * is not this ticket's problem.
 */
const FORWARD_LOOKING_DEPLOY_ACTION =
  /\b(deploy|deploys|deploying|deployment|redeploy|ship|shipping|release|releasing|roll ?out|rolling out|go live|going live|push (?:it )?to production|publish to production|merge|merging)\b|\b(deploye|deployen|deployer|publiser|publisere|publisering(?:en)?|lanser|lansere|lansering(?:en)?|rulle ut|utrulling(?:en)?|sette i produksjon|i produksjon|sl(?:å|a) sammen|flette)\b/i;

/** `commit abc1234`, or a bare full-length sha -- the shape DUR-3990 item 4 calls out. */
const COMMIT_REFERENCE =
  /\b(?:commit|sha|revision|rev)\s+`?[0-9a-f]{7,40}`?\b|\b[0-9a-f]{40}\b/i;

export type DeployDecisionCardSignal = "deploy_wording" | "approve_a_commit";

export interface DeployDecisionCardText {
  prompt?: unknown;
  acceptLabel?: unknown;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Reads the question an operator would actually see on the card: the prompt, plus the
 * accept button's label (an agent that writes "Deploy it" on the button is asking for a
 * deploy decision however the sentence above is phrased).
 */
export function confirmationQuestionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const card = payload as DeployDecisionCardText;
  return [readText(card.prompt), readText(card.acceptLabel)].filter(Boolean).join("\n");
}

/**
 * Whether this card's question asks the operator to authorize a deploy or merge. Returns
 * the signal that matched so the refusal can say which shape it saw, or null for a card
 * that is not asking for one.
 */
export function detectDeployDecisionAsk(payload: unknown): DeployDecisionCardSignal | null {
  const question = confirmationQuestionText(payload);
  if (!question) return null;
  if (!PERMISSION_ASK.test(question)) return null;
  if (FORWARD_LOOKING_DEPLOY_ACTION.test(question)) return "deploy_wording";
  if (COMMIT_REFERENCE.test(question)) return "approve_a_commit";
  return null;
}

/**
 * Agent-facing refusal. Says what is wrong, names the mechanism that does work, and -- per
 * DUR-3990 item 2 -- gives an agent that meant something else a way to rephrase, because
 * this is a wording match and will sometimes be wrong.
 */
export function deployDecisionRefusalMessage(signal: DeployDecisionCardSignal): string {
  const seen =
    signal === "deploy_wording"
      ? "This confirmation card asks the operator to approve a deploy, merge or release."
      : "This confirmation card asks the operator to approve a specific commit, which is a deploy decision.";
  return [
    seen,
    "A confirmation card cannot deploy or merge anything — answering it changes nothing, so the operator would be agreeing to something that never happens.",
    "File a deploy approval instead (a request_board_approval with a deploy payload). The deploy runner acts on that, and the operator decides it on the approval card.",
    "If this card is about something else, rewrite the question so it does not read as asking permission to deploy, merge or release, and create it again.",
  ].join(" ");
}

export type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  AskUserQuestionsPayload,
  AskUserQuestionsQuestion,
  AskUserQuestionsQuestionOption,
  AskUserQuestionsResult,
  IssueThreadInteraction,
  IssueThreadInteractionActorFields,
  IssueThreadInteractionBase,
  IssueThreadInteractionNamedApproval,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionStatus,
  RequestCheckboxConfirmationInteraction,
  RequestCheckboxConfirmationOption,
  RequestCheckboxConfirmationPayload,
  RequestCheckboxConfirmationResult,
  RequestConfirmationInteraction,
  RequestConfirmationIssueDocumentTarget,
  RequestConfirmationPayload,
  RequestConfirmationResult,
  RequestConfirmationTarget,
  SuggestedTaskDraft,
  SuggestTasksInteraction,
  SuggestTasksPayload,
  SuggestTasksResult,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  AskUserQuestionsQuestion,
  IssueThreadInteraction,
  RequestCheckboxConfirmationPayload,
  RequestCheckboxConfirmationResult,
  RequestConfirmationInteraction,
  RequestConfirmationTarget,
  SuggestedTaskDraft,
  SuggestTasksInteraction,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";

export interface SuggestedTaskTreeNode {
  task: SuggestedTaskDraft;
  children: SuggestedTaskTreeNode[];
}

export function isIssueThreadInteraction(
  value: unknown,
): value is IssueThreadInteraction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IssueThreadInteraction>;
  return typeof candidate.id === "string"
    && typeof candidate.companyId === "string"
    && typeof candidate.issueId === "string"
    && (
      candidate.kind === "suggest_tasks"
      || candidate.kind === "ask_user_questions"
      || candidate.kind === "request_confirmation"
      || candidate.kind === "request_checkbox_confirmation"
    );
}

export function getCheckboxConfirmationSelectedLabels(args: {
  payload: RequestCheckboxConfirmationPayload;
  result?: RequestCheckboxConfirmationResult | null;
}): string[] {
  const { payload, result } = args;
  const selectedIds = result?.selectedOptionIds ?? [];
  const optionLabelById = new Map(
    payload.options.map((option) => [option.id, option.label] as const),
  );
  return selectedIds
    .map((optionId) => optionLabelById.get(optionId))
    .filter((label): label is string => typeof label === "string");
}

export function normalizeRequestConfirmationTargetHref(href: string) {
  const value = href.trim();
  if (value.startsWith("#")) return value;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  return /^https?:\/\//i.test(value) ? value : null;
}

export function getRequestConfirmationTargetHref({
  issueId,
  target,
}: {
  issueId: string;
  target: RequestConfirmationTarget;
}) {
  if (target.href) {
    const safeHref = normalizeRequestConfirmationTargetHref(target.href);
    if (safeHref) return safeHref;
  }
  if (target.type === "issue_document") {
    const targetIssueId = target.issueId ?? issueId;
    return `/issues/${targetIssueId}#document-${encodeURIComponent(target.key)}`;
  }
  return null;
}

export function buildIssueThreadInteractionSummary(
  interaction: IssueThreadInteraction,
) {
  if (interaction.kind === "suggest_tasks") {
    const count = interaction.payload.tasks.length;
    if (interaction.status === "accepted") {
      const createdCount = interaction.result?.createdTasks?.length ?? 0;
      const skippedCount = interaction.result?.skippedClientKeys?.length ?? 0;
      if (skippedCount > 0) {
        return `Accepted ${createdCount} of ${count} tasks`;
      }
      return createdCount === 1 ? "Accepted 1 task" : `Accepted ${createdCount} tasks`;
    }
    if (interaction.status === "rejected") {
      return count === 1 ? "Rejected 1 task" : `Rejected ${count} tasks`;
    }
    return count === 1 ? "Suggested 1 task" : `Suggested ${count} tasks`;
  }

  if (interaction.kind === "request_confirmation") {
    if (interaction.status === "accepted") return "Confirmed request";
    if (interaction.status === "rejected") return "Declined request";
    if (interaction.status === "expired") {
      const outcome = interaction.result?.outcome;
      if (outcome === "superseded_by_comment") return "Confirmation expired after comment";
      if (outcome === "stale_target") return "Confirmation expired after target changed";
      if (outcome === "auto_resolved") return "Closed automatically";
      return "Confirmation expired";
    }
    return "Requested confirmation";
  }

  if (interaction.kind === "request_checkbox_confirmation") {
    const optionCount = interaction.payload.options.length;
    if (interaction.status === "accepted") {
      const selectedCount = interaction.result?.selectedOptionIds?.length ?? 0;
      if (selectedCount === 0) return "Confirmed with no options selected";
      return selectedCount === 1
        ? `Confirmed 1 of ${optionCount} options`
        : `Confirmed ${selectedCount} of ${optionCount} options`;
    }
    if (interaction.status === "rejected") return "Declined selection";
    if (interaction.status === "expired") {
      const outcome = interaction.result?.outcome;
      if (outcome === "superseded_by_comment") return "Selection expired after comment";
      if (outcome === "stale_target") return "Selection expired after target changed";
      if (outcome === "auto_resolved") return "Closed automatically";
      return "Selection expired";
    }
    return optionCount === 1
      ? "Requested a selection from 1 option"
      : `Requested a selection from ${optionCount} options`;
  }

  const count = interaction.payload.questions.length;
  if (interaction.status === "answered") {
    return count === 1 ? "Answered 1 question" : `Answered ${count} questions`;
  }
  if (interaction.status === "cancelled") {
    return count === 1 ? "Cancelled 1 question" : `Cancelled ${count} questions`;
  }
  if (interaction.status === "expired") {
    if (interaction.result?.expirationReason === "superseded_by_comment") {
      return count === 1 ? "Question expired after comment" : "Questions expired after comment";
    }
    return count === 1 ? "Question expired" : "Questions expired";
  }
  return count === 1 ? "Asked 1 question" : `Asked ${count} questions`;
}

export function buildSuggestedTaskTree(
  tasks: readonly SuggestedTaskDraft[],
): SuggestedTaskTreeNode[] {
  const nodes = new Map<string, SuggestedTaskTreeNode>();
  for (const task of tasks) {
    nodes.set(task.clientKey, { task, children: [] });
  }

  const roots: SuggestedTaskTreeNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.clientKey);
    if (!node) continue;
    const parentNode = task.parentClientKey ? nodes.get(task.parentClientKey) : null;
    if (parentNode) {
      parentNode.children.push(node);
      continue;
    }
    roots.push(node);
  }

  return roots;
}

export function countSuggestedTaskNodes(node: SuggestedTaskTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countSuggestedTaskNodes(child), 0);
}

export function collectSuggestedTaskClientKeys(node: SuggestedTaskTreeNode): string[] {
  return [
    node.task.clientKey,
    ...node.children.flatMap((child) => collectSuggestedTaskClientKeys(child)),
  ];
}

export function getQuestionAnswerLabels(args: {
  question: AskUserQuestionsQuestion;
  answers: readonly AskUserQuestionsAnswer[];
}) {
  const { question, answers } = args;
  const answer = answers.find((candidate) => candidate.questionId === question.id);
  const selectedIds = answer?.optionIds ?? [];
  const optionLabelById = new Map(
    question.options.map((option) => [option.id, option.label] as const),
  );
  const labels = selectedIds
    .map((optionId) => optionLabelById.get(optionId))
    .filter((label): label is string => typeof label === "string");
  const otherText = answer?.otherText?.trim();
  if (otherText) labels.push(`Other: ${otherText}`);
  return labels;
}

/** Reason sent to the agent when the operator closes an out-of-date card. */
export const NAMED_APPROVAL_OUT_OF_DATE_CLOSE_REASON =
  "Closed as out of date: the approval this asked about was already decided.";

export interface NamedApprovalState {
  /** The approval was already decided: nothing on this card matters any more. */
  outOfDate: boolean;
  /** Plain words for the operator. Never an id. */
  message: string;
}

function decidedWord(status: string) {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  return "withdrawn";
}

/**
 * What a pending confirmation card should say about the approval it is about
 * (the server fills `namedApproval` from the card's link or the approval it
 * names). Used by the issue-thread card and the Needs-you row on Now, so both
 * say the same thing and both stop offering an answer once it is decided.
 */
export function describeNamedApprovalState(
  interaction: Pick<IssueThreadInteraction, "kind" | "status" | "namedApproval">,
): NamedApprovalState | null {
  if (interaction.kind !== "request_confirmation" && interaction.kind !== "request_checkbox_confirmation") return null;
  if (interaction.status !== "pending") return null;
  const named = interaction.namedApproval;
  if (!named) return null;

  if (named.status === "approved" || named.status === "rejected" || named.status === "cancelled") {
    return {
      outOfDate: true,
      message:
        `Out of date: the approval this asks about was already ${decidedWord(named.status)}. ` +
        "There is nothing left to answer here.",
    };
  }
  if (named.status === "revision_requested") {
    return {
      outOfDate: false,
      message: named.linked
        ? "This is also on an approval card, which was sent back for changes. Answering here also answers that card."
        : "This is about an approval card that was sent back for changes. Answering here does not decide that approval.",
    };
  }
  return {
    outOfDate: false,
    message: named.linked
      ? "This is also on an approval card that is waiting for you. Answering here also answers that card."
      : "This is about an approval card that is still waiting for you. Answering here does not decide that approval.",
  };
}

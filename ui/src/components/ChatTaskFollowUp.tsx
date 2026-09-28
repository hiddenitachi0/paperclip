import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { RESEARCH_RESULT_DOCUMENT_KEY } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { chatApi, type ChatTaskAnswer } from "../api/chat";
import { queryKeys } from "../lib/queryKeys";

/**
 * Under a quick agent's reply that started a task (a hand-over, or a research
 * task it took on itself): the task's progress, and when it is done its answer
 * and a link to its result page. The same thing the Telegram bridge posts into
 * a chat, shown in the in-app chat.
 */

export const CHAT_TASK_POLL_INTERVAL_MS = 20_000;
const ANSWER_PREVIEW_MAX_CHARS = 1_500;
const FINISHED = new Set(["done", "cancelled"]);
const WAITING = new Set(["in_review", "blocked"]);

export function chatTaskLinks(item: Pick<ChatTaskAnswer, "id" | "identifier" | "resultDocument">) {
  const ref = item.identifier ?? item.id;
  return {
    taskPath: `/issues/${ref}`,
    resultPath: item.resultDocument ? `/issues/${ref}#document-${RESEARCH_RESULT_DOCUMENT_KEY}` : null,
  };
}

function previewOf(body: string): string {
  const text = body.trim();
  return text.length <= ANSWER_PREVIEW_MAX_CHARS ? text : `${text.slice(0, ANSWER_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

export function ChatTaskFollowUp({
  companyId,
  task,
}: {
  companyId: string;
  task: { issueId: string; identifier: string | null; title: string };
}) {
  const { data, isError } = useQuery({
    queryKey: queryKeys.issues.chatAnswer(companyId, task.issueId),
    queryFn: () => chatApi.answers(companyId, [task.issueId]),
    refetchInterval: (query) => {
      const status = query.state.data?.issues[0]?.status;
      return status && FINISHED.has(status) ? false : CHAT_TASK_POLL_INTERVAL_MS;
    },
  });
  const item = data?.issues.find((entry) => entry.id === task.issueId) ?? null;
  const ref = item?.identifier ?? task.identifier ?? "the task";
  if (!item) {
    if (isError || data) {
      return <p className="text-xs text-muted-foreground">Started {ref}.</p>;
    }
    return null;
  }
  const { taskPath, resultPath } = chatTaskLinks(item);
  const finished = FINISHED.has(item.status);
  const waiting = WAITING.has(item.status);
  return (
    <div className="mt-2 space-y-2 border-t pt-2 text-xs" data-testid="chat-task-follow-up">
      {finished || waiting ? (
        <p className="font-medium text-foreground">
          {item.status === "done" ? `✅ ${ref} is finished` : item.status === "cancelled" ? `✖️ ${ref} was cancelled` : `⏸ ${ref} is waiting and may need you`}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working on {ref}. The result shows up here when it is ready.
        </p>
      )}
      {(finished || waiting) && item.answer ? (
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{previewOf(item.answer.body)}</p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {resultPath ? (
          <Link to={resultPath} className="underline underline-offset-2 hover:text-foreground">
            Open the result page
          </Link>
        ) : null}
        <Link to={taskPath} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
          Open the task
        </Link>
      </div>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelConverterOp } from "@paperclipai/shared";
import { AlertTriangle, Loader2, Undo2 } from "lucide-react";
import {
  modelDirectoryApi,
  type ModelReview,
  type ModelReviewChange,
  type ModelReviewSettings,
  type ModelReviewState,
} from "../api/modelDirectory";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * The "check-up" part of a saved model: the latest report with scores, fixes
 * waiting for a yes/no, and the history of fixes with a one-click undo.
 * Everything here is plain words; internal codes never reach the screen.
 */

function reviewError(error: unknown, doing: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return `Only the company owner or an admin can ${doing}.`;
    return error.message;
  }
  return `Could not ${doing}. Please try again.`;
}

export function describeOp(op: ModelConverterOp): string {
  switch (op.op) {
    case "drop_param":
      return `Stop sending the "${op.param}" option`;
    case "rename_param":
      return `Send the "${op.from}" option as "${op.to}"`;
    case "set_default_param":
      return `Always send "${op.param}" as ${JSON.stringify(op.value)}`;
    case "cap_tool_count":
      return `Offer at most ${op.max} tools at a time`;
    case "tool_description_variant":
      return op.variant === "short" ? "Describe tools in fewer words" : "Describe tools in plainer words";
    case "system_prompt_hint":
      return `Add a hint to the instructions: "${op.hint}"`;
    case "strip_output_wrapper":
      return "Remove the model's private thinking text from its answers";
    case "parse_text_tool_call":
      return "Understand tool requests written out as plain text";
    case "retry_once":
      return "Try once more with different options if a request fails";
    default:
      return "Another adjustment";
  }
}

function describeSettings(s: ModelReviewSettings): string[] {
  return [
    `Thinking: ${s.defaultThinking === "on" ? "on" : s.defaultThinking === "off" ? "off" : "the model's own choice"}`,
    `Creativity: ${s.defaultTemperature ?? "default"}`,
    `Answer length: ${s.defaultMaxOutputTokens ?? "default"}`,
  ];
}

/** Plain list of what differs between two states; empty when nothing does. */
export function describeDifference(before: ModelReviewState, after: ModelReviewState): string[] {
  const out: string[] = [];
  const b = describeSettings(before.settings);
  const a = describeSettings(after.settings);
  a.forEach((line, i) => {
    if (line !== b[i]) out.push(`${b[i]}  →  ${line}`);
  });
  const key = (op: ModelConverterOp) => JSON.stringify(op);
  const beforeKeys = new Set(before.ops.map(key));
  const afterKeys = new Set(after.ops.map(key));
  for (const op of after.ops) if (!beforeKeys.has(key(op))) out.push(`Added: ${describeOp(op)}`);
  for (const op of before.ops) if (!afterKeys.has(key(op))) out.push(`Removed: ${describeOp(op)}`);
  return out;
}

function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="space-y-1" data-testid={`model-score-${label.toLowerCase()}`}>
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">{value === null ? "Not tested" : `${value} out of 100`}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted">
        {value !== null && (
          <div
            className={`h-1.5 rounded-full ${value >= 80 ? "bg-green-500" : value >= 50 ? "bg-amber-500" : "bg-red-500"}`}
            style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
          />
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<ModelReviewChange["status"], string> = {
  applied: "Done",
  proposed: "Waiting for you",
  declined: "You said no",
  undone: "Undone",
};

export function ModelReviewPanel({
  companyId,
  entryId,
  canManage,
}: {
  companyId: string;
  entryId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [showHistory, setShowHistory] = useState(false);
  const key = queryKeys.companies.modelReviews(companyId, entryId);
  const reviewsQuery = useQuery({
    queryKey: key,
    queryFn: () => modelDirectoryApi.listReviews(companyId, entryId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const runMutation = useMutation({
    mutationFn: () => modelDirectoryApi.runReview(companyId, entryId),
    onSuccess: () => {
      refresh();
      // The saved setup itself may have been fixed.
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.modelDirectory(companyId) });
      pushToast({ title: "Check-up finished", tone: "success" });
    },
    onError: (e) => pushToast({ title: reviewError(e, "check this model"), tone: "error" }),
  });
  const decideMutation = useMutation({
    mutationFn: (v: { review: ModelReview; change: ModelReviewChange; action: "apply" | "decline" | "undo" }) =>
      modelDirectoryApi.decideChange(companyId, entryId, v.review.id, v.change.id, v.action),
    onSuccess: (_data, v) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.modelDirectory(companyId) });
      pushToast({
        title: v.action === "apply" ? "Fix applied" : v.action === "undo" ? "Fix undone" : "Fix declined",
        tone: "success",
      });
    },
    onError: (e, v) =>
      pushToast({
        title: reviewError(e, v.action === "undo" ? "undo this fix" : v.action === "apply" ? "apply this fix" : "decline this fix"),
        tone: "error",
      }),
  });

  if (reviewsQuery.isError) {
    return (
      <p className="text-xs text-destructive" data-testid="model-review-error">
        {reviewError(reviewsQuery.error, "see the check-ups")}{" "}
        <Button variant="ghost" size="sm" onClick={() => reviewsQuery.refetch()}>
          Try again
        </Button>
      </p>
    );
  }
  if (reviewsQuery.isPending) return <p className="text-xs text-muted-foreground">Loading check-ups…</p>;

  const reviews = reviewsQuery.data ?? [];
  const latest = reviews[0] ?? null;
  const pending = reviews.flatMap((review) =>
    review.changes.filter((c) => c.status === "proposed").map((change) => ({ review, change })),
  );
  const history = reviews.flatMap((review) =>
    review.changes.filter((c) => c.status !== "proposed").map((change) => ({ review, change })),
  );
  const busy = decideMutation.isPending;

  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="model-review-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="section-title">Check-up</div>
        {canManage && (
          <Button size="sm" variant="outline" disabled={runMutation.isPending} onClick={() => runMutation.mutate()}>
            {runMutation.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {latest ? "Check again" : "Check this model"}
          </Button>
        )}
      </div>

      {!latest ? (
        <p className="text-xs" data-testid="model-review-empty">
          This model has not been checked yet.
          {canManage ? " Press the button to test it and see if its setup can be improved." : ""}
        </p>
      ) : (
        <div className="space-y-2" data-testid="model-review-report">
          <p className="text-xs text-muted-foreground">Last checked {when(latest.createdAt)}</p>
          <p className="text-xs text-foreground">{latest.report.summary}</p>
          <div className="grid grid-cols-3 gap-3">
            <ScoreBar label="Chat" value={latest.report.scores.chat} />
            <ScoreBar label="Tools" value={latest.report.scores.tools} />
            <ScoreBar label="Pictures" value={latest.report.scores.pictures} />
          </div>
          {latest.report.findings.length > 0 && (
            <ul className="list-disc space-y-1 pl-4 text-xs" data-testid="model-review-findings">
              {latest.report.findings.map((f, i) => (
                <li key={`${f.code}-${i}`}>{f.text}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-2" data-testid="model-review-pending">
          <div className="text-xs font-medium text-foreground">Waiting for your decision</div>
          {pending.map(({ review, change }) => (
            <div
              key={change.id}
              className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
              data-testid={`model-review-pending-${change.id}`}
            >
              <p className="text-sm font-medium text-foreground">{change.title}</p>
              <p className="text-xs">{change.why}</p>
              {change.dropsCapability && (
                <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This would turn something off for this model (such as tools or pictures), so it needs your yes.
                </p>
              )}
              <ul className="list-disc pl-4 text-xs">
                {describeDifference(change.before, change.after).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {canManage ? (
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => decideMutation.mutate({ review, change, action: "apply" })}>
                    Apply this fix
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => decideMutation.mutate({ review, change, action: "decline" })}
                  >
                    No thanks
                  </Button>
                </div>
              ) : (
                <p className="text-xs">Only the company owner or an admin can decide on this.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="space-y-2" data-testid="model-review-history">
          <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide past fixes" : `Show past fixes (${history.length})`}
          </Button>
          {showHistory && (
            <ul className="space-y-2">
              {history.map(({ review, change }) => (
                <li key={change.id} className="space-y-1 rounded-md border border-border p-3" data-testid={`model-review-history-${change.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{change.title}</span>
                    <Badge variant="outline">{STATUS_LABEL[change.status]}</Badge>
                  </div>
                  <p className="text-xs">{change.why}</p>
                  <ul className="list-disc pl-4 text-xs">
                    {describeDifference(change.before, change.after).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="text-xs">{when(change.decidedAt ?? review.createdAt)}</p>
                  {canManage && change.status === "applied" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => decideMutation.mutate({ review, change, action: "undo" })}
                    >
                      <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Undo this fix
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

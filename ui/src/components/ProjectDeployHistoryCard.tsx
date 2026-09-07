import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectDeployPolicy } from "@paperclipai/shared";
import { RotateCcw } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { approvalsApi } from "../api/approvals";
import { ApiError } from "../api/client";
import { deployRunnerApi, type ProjectDeployHistory } from "../api/deployRunner";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildRollbackDeployApproval, rollbackConfirmText, shortSha } from "../lib/rollback-deploy";
import { timeAgo } from "../lib/timeAgo";

/**
 * DUR-3952 follow-up: the operator's one-click rollback. Shows which version
 * of the project is live and which was live before it (both straight from
 * the deploy runner's own log), and files a rollback approval card for the
 * previous one. The card itself is an ordinary deploy approval with
 * `allowBackwardDeploy` set -- the server only accepts that flag from the
 * board (a person signed in here, or a board API key), so this button is
 * board-only by construction; agents get a plain 403 if they try.
 */
export function ProjectDeployHistoryCard({
  companyId,
  projectId,
  deployPolicy,
}: {
  companyId: string;
  projectId: string;
  deployPolicy: ProjectDeployPolicy | null | undefined;
}) {
  const enabled = Boolean(deployPolicy?.enabled && deployPolicy.workspaceId);
  const historyQuery = useQuery({
    queryKey: queryKeys.projects.deployHistory(companyId, projectId),
    queryFn: () => deployRunnerApi.projectDeployHistory(companyId, projectId),
    enabled,
  });

  if (!enabled || !deployPolicy) return null;

  return (
    <ProjectDeployHistoryCardView
      companyId={companyId}
      projectId={projectId}
      workspaceId={deployPolicy.workspaceId}
      history={historyQuery.data ?? null}
      isLoading={historyQuery.isLoading}
      error={historyQuery.error as Error | null}
    />
  );
}

/** The id of the already-open card a 409 "duplicate approval" refusal points at, if any. */
export function existingApprovalIdFromError(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const details = (err.body as { details?: { existingApprovalId?: unknown } } | null)?.details;
  return typeof details?.existingApprovalId === "string" && details.existingApprovalId ? details.existingApprovalId : null;
}

export function ProjectDeployHistoryCardView({
  companyId,
  projectId,
  workspaceId,
  history,
  isLoading,
  error,
  confirm = (text: string) => window.confirm(text),
}: {
  companyId: string;
  projectId: string;
  workspaceId: string;
  history: ProjectDeployHistory | null;
  isLoading: boolean;
  error: Error | null;
  confirm?: (text: string) => boolean;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const current = history?.current ?? null;
  const previous = history?.previous ?? null;

  const fileRollback = useMutation({
    mutationFn: () => {
      if (!current || !previous) throw new Error("There is no previous version to roll back to yet.");
      return approvalsApi.create(companyId, buildRollbackDeployApproval({ projectId, workspaceId, current, previous }));
    },
    onSuccess: (approval) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
      pushToast({
        title: `Rollback request filed for ${shortSha(previous!.commit)}`,
        body: "Nothing has changed yet. Approve the card to move production back; reject it to keep the current version.",
        tone: "success",
        action: { label: "Open the card", href: `/approvals/${approval.id}` },
      });
    },
    onError: (err: Error) => {
      // The server refuses a rollback only when the same rollback is already waiting for a
      // decision (409 with the waiting card's id) -- send the operator to that card rather
      // than leaving them with an error they cannot act on.
      const waitingCardId = existingApprovalIdFromError(err);
      pushToast({
        title: waitingCardId ? "This rollback is already waiting for you" : "Could not file the rollback request",
        body: err.message,
        tone: waitingCardId ? "info" : "error",
        action: waitingCardId ? { label: "Open the waiting card", href: `/approvals/${waitingCardId}` } : undefined,
      });
    },
  });

  const onRollbackClick = () => {
    if (!current || !previous) return;
    if (!confirm(rollbackConfirmText(previous, current))) return;
    fileRollback.mutate();
  };

  return (
    <Card className="border-border/70 bg-card/80" data-testid="project-deploy-history">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Production version</CardTitle>
        <CardDescription>What the deploy runner has put live for this project.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isLoading ? (
          <p className="text-muted-foreground">Checking the deploy log...</p>
        ) : error ? (
          <p className="text-destructive">Could not read the deploy log: {error.message}</p>
        ) : !current ? (
          <p className="text-muted-foreground">No version has been deployed by the runner yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <span className="text-muted-foreground">Live now</span>
                <p className="font-mono" data-testid="deploy-history-current">
                  {shortSha(current.commit)}
                  <span className="ml-2 font-sans text-muted-foreground">deployed {timeAgo(current.deployedAt)}</span>
                </p>
                <Link to={`/approvals/${current.approvalId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                  See the deploy card
                </Link>
              </div>
              <div>
                <span className="text-muted-foreground">Before that</span>
                {previous ? (
                  <p className="font-mono" data-testid="deploy-history-previous">
                    {shortSha(previous.commit)}
                    <span className="ml-2 font-sans text-muted-foreground">deployed {timeAgo(previous.deployedAt)}</span>
                  </p>
                ) : (
                  <p className="text-muted-foreground">No earlier version on record.</p>
                )}
              </div>
            </div>
            {previous ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground">
                  Something wrong with {shortSha(current.commit)}? You can ask to go back to {shortSha(previous.commit)}. This
                  files a card for you to approve; nothing changes until you do.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRollbackClick}
                  disabled={fileRollback.isPending}
                  data-testid="deploy-history-rollback"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {fileRollback.isPending ? "Filing..." : "Roll back to previous version"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

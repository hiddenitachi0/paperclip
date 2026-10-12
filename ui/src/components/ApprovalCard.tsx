import { useState } from "react";
import { CheckCircle2, XCircle, Clock, AlertTriangle, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Identity } from "./Identity";
import { DecisionReasonDialog } from "./DecisionReasonDialog";
import { ApprovalPreviewPanel } from "./ApprovalPreviewPanel";
import {
  approvalSubject,
  approvalTechnicalReference,
  approvalDeployBranchInfo,
  approvalDeployChangeSummaryText,
  approvalDeployTargetCommitText,
  approvalIsRollbackDeploy,
  typeIcon,
  defaultTypeIcon,
  ApprovalPayloadRenderer,
  typeLabel,
} from "./ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import { formatAgentDisplayName, type Approval, type Agent, type Issue, type SecurityReviewState } from "@paperclipai/shared";
import { cn } from "@/lib/utils";

/** DUR-4566: the plain-words line a merge card shows for its security-review state. */
function securityReviewSummary(review: SecurityReviewState): { text: string; tone: "neutral" | "warn" | "ok" } {
  switch (review.state) {
    case "not_requested":
      return { text: "Security review: not requested", tone: "warn" };
    case "no_reviewer_configured":
      return { text: "Security review: no reviewer chosen yet for this company", tone: "warn" };
    case "in_progress":
      return { text: "Security review: in progress", tone: "neutral" };
    case "passed":
      return { text: "Security review: passed", tone: "ok" };
    case "failed":
      return { text: "Security review: found problems", tone: "warn" };
    case "out_of_date":
      return { text: "Security review: out of date — code changed after the review", tone: "warn" };
    default:
      return { text: "Security review: not requested", tone: "warn" };
  }
}

function securityReviewIcon(review: SecurityReviewState) {
  if (review.state === "passed") return <ShieldCheck className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (review.state === "in_progress") return <ShieldQuestion className="h-3.5 w-3.5 text-muted-foreground" />;
  return <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
}

function statusIcon(status: string) {
  if (status === "approved") return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (status === "rejected") return <XCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  if (status === "revision_requested") return <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
  if (status === "pending") return <Clock className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />;
  return null;
}

export function ApprovalCard({
  approval,
  requesterAgent,
  onApprove,
  onApproveWithoutSecurityReview,
  onReject,
  onRequestSecurityReview,
  isRequestingSecurityReview = false,
  onOpen,
  detailLink,
  isPending = false,
  pendingAction = null,
  linkedIssues,
  companyName = null,
}: {
  approval: Approval;
  requesterAgent: Agent | null;
  onApprove?: () => void;
  // DUR-4566 item 4: approving a merge card with no passed security review
  // at its current head commit needs a reason, recorded in the activity log.
  onApproveWithoutSecurityReview?: (reason: string) => void;
  onReject?: (note: string) => void;
  // DUR-4566 item 2: shown when the state is not_requested, failed, or
  // out_of_date. The button is single-flight server-side; this just disables
  // it while a request from this card is in flight.
  onRequestSecurityReview?: () => void;
  isRequestingSecurityReview?: boolean;
  onOpen?: () => void;
  detailLink?: string;
  isPending?: boolean;
  pendingAction?: "approve" | "reject" | null;
  // Undefined = caller hasn't checked (e.g. embedded on the issue's own
  // thread, where the ticket is already the surrounding page). An array —
  // even empty — means the caller resolved the link and an empty result is
  // a real defect worth flagging (see DUR-211).
  linkedIssues?: Issue[];
  companyName?: string | null;
}) {
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [approveWithoutReviewDialogOpen, setApproveWithoutReviewDialogOpen] = useState(false);
  const payload = approval.payload as Record<string, unknown> | null;
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const kindLabel = typeLabel[approval.type] ?? approval.type;
  const subject = approvalSubject(payload);
  const technicalReference = approvalTechnicalReference(payload);
  const branchInfo = approvalDeployBranchInfo(payload);
  const isRollback = approvalIsRollbackDeploy(payload);
  const deployChangeSummary = approvalDeployChangeSummaryText(payload);
  const deployTargetCommit = approvalDeployTargetCommitText(payload);
  const issueRefs = (linkedIssues ?? [])
    .map((issue) => issue.identifier)
    .filter((identifier): identifier is string => Boolean(identifier));
  const showNoTicketFlag = linkedIssues !== undefined && issueRefs.length === 0;
  const showResolutionButtons =
    Boolean(onApprove && onReject) &&
    approval.type !== "budget_override_required" &&
    (approval.status === "pending" || approval.status === "revision_requested");
  const hasFooter = showResolutionButtons || Boolean(detailLink || onOpen);
  const securityReview = approval.securityReview ?? null;
  // DUR-4566 item 4: gated unless the review passed at the card's current head commit.
  const approveGatedBySecurityReview = securityReview !== null && securityReview.state !== "passed";
  const showRequestSecurityReviewButton =
    securityReview !== null &&
    Boolean(onRequestSecurityReview) &&
    (securityReview.state === "not_requested" ||
      securityReview.state === "failed" ||
      securityReview.state === "out_of_date" ||
      securityReview.state === "no_reviewer_configured");

  return (
    <div className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/80">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
                >
                  {kindLabel}
                </Badge>
                {companyName && (
                  <Badge
                    variant="secondary"
                    className="px-2 py-0.5 text-[11px] font-medium"
                  >
                    {companyName}
                  </Badge>
                )}
                {branchInfo && !branchInfo.mismatch && (
                  <Badge
                    variant="outline"
                    className="border-border/70 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                  >
                    Deploys from {branchInfo.sourceBranch}
                  </Badge>
                )}
                {requesterAgent && (
                  <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span>Requested by</span>
                    <Identity
                      name={formatAgentDisplayName(requesterAgent, requesterAgent.persona)}
                      size="sm"
                      className="inline-flex"
                    />
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <h3 className="flex flex-wrap items-center gap-1.5 text-base font-semibold leading-6 text-foreground">
                  {issueRefs.length > 0 &&
                    issueRefs.map((ref) => (
                      <span
                        key={ref}
                        className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-sm text-primary"
                      >
                        {ref}
                      </span>
                    ))}
                  {showNoTicketFlag && (
                    <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      No linked ticket
                    </span>
                  )}
                  {branchInfo?.mismatch && (
                    <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      Not on {branchInfo.deployBranch} — this commit is on {branchInfo.sourceBranch}
                    </span>
                  )}
                  {isRollback && (
                    <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      Rollback — approving moves production back to an older version
                    </span>
                  )}
                  <span>{subject ?? kindLabel}</span>
                </h3>
                <p className="text-xs leading-5 text-muted-foreground">
                  Approval request created {timeAgo(approval.createdAt)}
                </p>
                {deployTargetCommit && (
                  <p className="text-xs leading-5 text-muted-foreground">{deployTargetCommit}</p>
                )}
                {deployChangeSummary && (
                  <p className="text-xs leading-5 text-muted-foreground">{deployChangeSummary}</p>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs text-muted-foreground">
            {statusIcon(approval.status)}
            <span className="capitalize">{approval.status.replace(/_/g, " ")}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-border/60 pt-4">
        <ApprovalPayloadRenderer
          type={approval.type}
          payload={approval.payload}
          hidePrimaryTitle={Boolean(subject)}
          approvalId={approval.id}
          companyId={approval.companyId}
        />
      </div>

      <ApprovalPreviewPanel
        approvalId={approval.id}
        approvalType={approval.type}
        payload={payload}
        approvalStatus={approval.status}
      />

      {securityReview && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2.5 text-xs leading-5">
          <div className="flex items-center gap-1.5">
            {securityReviewIcon(securityReview)}
            <span className="font-medium text-foreground">{securityReviewSummary(securityReview).text}</span>
            {securityReview.state === "in_progress" && securityReview.reviewIssueIdentifier && (
              <Link
                to={`/issues/${securityReview.reviewIssueIdentifier}`}
                className="text-muted-foreground underline underline-offset-2"
              >
                ({securityReview.reviewIssueIdentifier})
              </Link>
            )}
            {securityReview.state === "failed" && securityReview.verdictCommentUrl && (
              <a
                href={securityReview.verdictCommentUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline underline-offset-2"
              >
                See findings
              </a>
            )}
          </div>
          {showRequestSecurityReviewButton && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={onRequestSecurityReview}
              disabled={isRequestingSecurityReview}
            >
              {isRequestingSecurityReview ? "Requesting…" : "Request security review"}
            </Button>
          )}
        </div>
      )}

      {approval.decisionNote && (
        <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Decision note.</span> {approval.decisionNote}
        </div>
      )}

      {technicalReference && (
        <p className="mt-3 truncate font-mono text-[10.5px] text-muted-foreground/70" title={technicalReference}>
          {technicalReference}
        </p>
      )}

      {hasFooter ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {showResolutionButtons && (
              <>
                <Button
                  size="sm"
                  className={
                    approveGatedBySecurityReview
                      ? "border border-amber-600/50 bg-transparent text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                      : "bg-green-700 hover:bg-green-600 text-white"
                  }
                  variant={approveGatedBySecurityReview ? "outline" : "default"}
                  onClick={() => {
                    if (approveGatedBySecurityReview) setApproveWithoutReviewDialogOpen(true);
                    else onApprove?.();
                  }}
                  disabled={isPending}
                >
                  {pendingAction === "approve"
                    ? "Approving..."
                    : approveGatedBySecurityReview
                      ? "Approve without security review"
                      : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setRejectDialogOpen(true)}
                  disabled={isPending}
                >
                  {pendingAction === "reject" ? "Rejecting..." : "Reject"}
                </Button>
              </>
            )}
          </div>
          {(detailLink || onOpen) ? (
            detailLink ? (
              <Link
                to={detailLink}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-auto px-2 text-xs text-muted-foreground")}
              >
                View details
              </Link>
            ) : (
              <Button variant="ghost" size="sm" className="h-auto px-2 text-xs text-muted-foreground" onClick={onOpen}>
                View details
              </Button>
            )
          ) : null}
        </div>
      ) : null}
      {showResolutionButtons && (
        <DecisionReasonDialog
          open={rejectDialogOpen}
          onOpenChange={setRejectDialogOpen}
          action="reject"
          isPending={isPending}
          onSubmit={(note) => {
            setRejectDialogOpen(false);
            onReject?.(note);
          }}
        />
      )}
      {showResolutionButtons && approveGatedBySecurityReview && (
        <DecisionReasonDialog
          open={approveWithoutReviewDialogOpen}
          onOpenChange={setApproveWithoutReviewDialogOpen}
          action="approve_without_review"
          isPending={isPending}
          onSubmit={(reason) => {
            setApproveWithoutReviewDialogOpen(false);
            onApproveWithoutSecurityReview?.(reason);
          }}
        />
      )}
    </div>
  );
}

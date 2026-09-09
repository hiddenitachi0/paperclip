import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, MonitorPlay } from "lucide-react";
import { isPreviewableApprovalPayload } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { approvalsApi } from "../api/approvals";
import { ApiError } from "../api/client";
import { useOptionalToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * "Preview this before approving."
 *
 * The operator's answer to being asked to approve code they have never seen.
 * Starting a preview makes a throwaway copy of exactly what this card would
 * ship, runs it here, and hands back a link. It shuts itself down when the
 * card is decided, or after an hour of nobody looking at it.
 */
export function ApprovalPreviewPanel({
  approvalId,
  approvalType,
  payload,
  approvalStatus,
}: {
  approvalId: string;
  approvalType: string;
  payload: Record<string, unknown> | null;
  approvalStatus: string;
}) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const relevant =
    isPreviewableApprovalPayload(approvalType, payload)
    && (approvalStatus === "pending" || approvalStatus === "revision_requested");

  const previewQuery = useQuery({
    queryKey: queryKeys.approvals.preview(approvalId),
    queryFn: () => approvalsApi.getPreview(approvalId),
    enabled: relevant,
    // While a copy is starting, keep asking so the link appears on its own.
    refetchInterval: (query) =>
      query.state.data?.preview?.status === "starting" ? 3000 : false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.preview(approvalId) });
  };

  const start = useMutation({
    mutationFn: () => approvalsApi.startPreview(approvalId),
    onSuccess: invalidate,
    onError: (error: unknown) => {
      toast?.pushToast({
        title: "The preview could not be started",
        body: error instanceof ApiError && error.message ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const stop = useMutation({
    mutationFn: () => approvalsApi.stopPreview(approvalId),
    onSuccess: invalidate,
    onError: () => toast?.pushToast({ title: "The preview could not be stopped", tone: "error" }),
  });

  if (!relevant) return null;
  const view = previewQuery.data;
  if (!view) return null;

  const preview = view.preview;
  const status = preview?.status ?? "stopped";
  const showLink = status === "ready" && Boolean(preview?.previewUrl);
  const busy = start.isPending || stop.isPending || status === "starting";

  return (
    <div className="mt-4 rounded-lg border border-border/60 bg-muted/20 px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <MonitorPlay className="h-3.5 w-3.5" />
            Try it first
          </p>
          <p className="mt-1 text-sm leading-6 text-foreground/90">
            {preview
              ? preview.message
              : view.availability.canStart
                ? `Start a copy of ${view.availability.ref?.label ?? "this change"} and click around before you decide.`
                : (view.availability.blockedReason ?? "Nothing is running for this branch yet.")}
          </p>
          {showLink && (
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              Links written from the site root may still take you back to Paperclip — that is the copy, not a
              problem with the change.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showLink && (
            <a
              href={preview!.previewUrl!}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              Open the preview
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {status === "starting" && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Starting
            </span>
          )}
          {(status === "ready" || status === "starting") ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs text-muted-foreground"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              {stop.isPending ? "Closing..." : "Close it"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!view.availability.canStart || busy}
              onClick={() => start.mutate()}
            >
              {start.isPending
                ? "Starting..."
                : status === "failed"
                  ? "Try again"
                  : "Preview this before approving"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

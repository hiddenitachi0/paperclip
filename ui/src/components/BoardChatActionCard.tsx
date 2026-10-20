import { useState } from "react";
import type { BoardChatAction } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

/**
 * One change Board chat prepared, shown inline in the chat. Nothing is
 * changed until the person who asked clicks Approve; Cancel drops it.
 */

const STATUS_TEXT: Record<BoardChatAction["status"], string> = {
  pending: "Waiting for your approval",
  executing: "Approved, making the change...",
  done: "Approved and done",
  failed: "Approved, but it didn't go through",
  cancelled: "Cancelled",
  expired: "Not approved in time",
};

const LONG_VALUE = 280;

function DetailValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= LONG_VALUE) return <span className="whitespace-pre-wrap break-words">{value}</span>;
  return (
    <span className="whitespace-pre-wrap break-words">
      {expanded ? value : `${value.slice(0, LONG_VALUE)}…`}{" "}
      <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Show less" : "Show all"}
      </button>
    </span>
  );
}

export function BoardChatActionCard({
  action,
  canDecide,
  busy,
  error,
  onApprove,
  onCancel,
}: {
  action: BoardChatAction;
  /** True when the signed-in person is the one who asked for it. */
  canDecide: boolean;
  busy: boolean;
  error?: string | null;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const pending = action.status === "pending";
  return (
    <div
      className={cn(
        "max-w-[min(42rem,100%)] rounded-xl border px-4 py-3 text-sm",
        pending ? "border-amber-500/50 bg-amber-500/5" : "border-border bg-card",
      )}
      data-testid="board-chat-action-card"
      data-status={action.status}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {pending && !canDecide ? "Waiting for the person who asked to approve it" : STATUS_TEXT[action.status]}
      </div>
      <div className="mt-1 font-semibold text-foreground" data-testid="board-chat-action-summary">
        {action.summary}
      </div>
      {action.details.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
          {action.details.map((detail, index) => (
            <div key={`${detail.label}-${index}`} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="text-foreground">
                <DetailValue value={detail.value} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {action.resultMessage && !pending ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="board-chat-action-result">
          {action.resultMessage}
        </p>
      ) : null}
      {pending && canDecide ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">Nothing changes until you click Approve.</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove} disabled={busy} data-testid="board-chat-action-approve">
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel} disabled={busy} data-testid="board-chat-action-cancel">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

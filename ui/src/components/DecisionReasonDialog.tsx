import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const REJECT_QUICK_REASONS = [
  "Replaced by a newer deploy",
  "Duplicate request",
  "Already live",
  "Wrong branch",
];

export type DecisionReasonAction = "reject" | "revision";

// Both reject and "ask for changes" require a reason so the requesting agent
// never has to come back and ask why — see DUR-282.
export function DecisionReasonDialog({
  open,
  onOpenChange,
  action,
  isPending = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: DecisionReasonAction;
  isPending?: boolean;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const isReject = action === "reject";

  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  const trimmed = note.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isReject ? "Reject this request" : "Ask for changes"}</DialogTitle>
          <DialogDescription>
            {isReject
              ? "Say why, so the agent that filed this doesn't have to ask you later."
              : "Say what needs to change so the agent knows what to fix."}
          </DialogDescription>
        </DialogHeader>

        {isReject && (
          <div className="flex flex-wrap gap-1.5">
            {REJECT_QUICK_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                onClick={() => setNote(reason)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  note === reason
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/70 text-muted-foreground hover:bg-accent/40",
                )}
              >
                {reason}
              </button>
            ))}
          </div>
        )}

        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            isReject ? "Why are you rejecting this? (or pick one above)" : "What should the agent change?"
          }
          rows={3}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={isReject ? "destructive" : "default"}
            onClick={() => onSubmit(trimmed)}
            disabled={isPending || trimmed.length === 0}
          >
            {isPending
              ? isReject
                ? "Rejecting…"
                : "Sending…"
              : isReject
                ? "Reject"
                : "Ask for changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

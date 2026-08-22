import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Send } from "lucide-react";
import { useTranslation } from "@/i18n";
import { routinesApi } from "../api/routines";
import { ApiError } from "../api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { EmptyState } from "./EmptyState";
import { timeAgo } from "../lib/timeAgo";

const OUTCOME_BADGE_VARIANT: Record<string, "secondary" | "destructive" | "outline"> = {
  accepted: "secondary",
  duplicate: "outline",
  rejected_signature: "destructive",
  rejected_shape: "destructive",
  failed: "destructive",
  unknown_target: "destructive",
};

/**
 * The "Leveranser" section (DUR-68): last 100 deliveries to this trigger's
 * customer-inbox address. No message bodies are ever shown here -- only
 * sender, subject-free metadata, and outcome, matching what the ledger
 * endpoint returns.
 */
export function CustomerInboxDeliveries({ routineId, triggerId }: { routineId: string; triggerId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const { data: deliveries, isLoading } = useQuery({
    queryKey: ["routines", routineId, "customer-inbox-deliveries"],
    queryFn: () => routinesApi.customerInboxDeliveries(routineId, 100),
  });

  const sendTestMessage = useMutation({
    mutationFn: () => routinesApi.sendCustomerInboxTestMessage(routineId, triggerId),
    onSuccess: () => {
      setFeedback({ kind: "success", text: t("routines.customerInbox.testMessage.success", { defaultValue: "Test message sent." }) });
      queryClient.invalidateQueries({ queryKey: ["routines", routineId, "customer-inbox-deliveries"] });
    },
    onError: (err) => {
      setFeedback({
        kind: "error",
        text: err instanceof ApiError ? err.message : t("routines.customerInbox.testMessage.error", { defaultValue: "Could not send test message." }),
      });
    },
  });

  const rows = deliveries ?? [];

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {t("routines.customerInbox.deliveries.title", { defaultValue: "Deliveries" })}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFeedback(null);
            sendTestMessage.mutate();
          }}
          disabled={sendTestMessage.isPending}
        >
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {sendTestMessage.isPending
            ? t("routines.customerInbox.testMessage.sending", { defaultValue: "Sending…" })
            : t("routines.customerInbox.testMessage.button", { defaultValue: "Send test message" })}
        </Button>
      </div>

      {feedback && (
        <p className={`text-xs ${feedback.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {feedback.text}
        </p>
      )}

      {!isLoading && rows.length === 0 ? (
        <EmptyState icon={Inbox} message={t("routines.customerInbox.deliveries.empty", { defaultValue: "No deliveries yet." })} />
      ) : (
        <div className="rounded-lg border border-border">
          {rows.map((delivery) => (
            <div
              key={delivery.id}
              className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
            >
              <Badge variant={OUTCOME_BADGE_VARIANT[delivery.outcome] ?? "outline"} className="shrink-0">
                {t(`routines.customerInbox.deliveries.outcome.${delivery.outcome}`, { defaultValue: delivery.outcome })}
              </Badge>
              <span className="text-xs text-muted-foreground shrink-0">
                {delivery.channel
                  ? t(`routines.customerInbox.deliveries.channel.${delivery.channel}`, { defaultValue: delivery.channel })
                  : "—"}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {delivery.fromName || delivery.fromAddress || "—"}
              </span>
              {delivery.issueIdentifier ? (
                <Link
                  to={`/issues/${delivery.issueIdentifier}`}
                  className="shrink-0 text-xs text-primary hover:underline"
                >
                  {delivery.issueIdentifier}
                </Link>
              ) : null}
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(delivery.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

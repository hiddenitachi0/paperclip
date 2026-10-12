import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type WebhookSecretEntry = { webhookUrl: string; webhookSecret: string };

/**
 * One-time display of a webhook address and password right after it was made
 * or changed. The password is never shown again, so the warning stays visible.
 */
export function WebhookSecretReveal({
  title,
  entries,
  onCopy,
  onDismiss,
}: {
  title: string;
  entries: WebhookSecretEntry[];
  onCopy: (label: string, value: string) => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{title}</p>
        {onDismiss ? (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Done
          </Button>
        ) : null}
      </div>
      <div className="space-y-4">
        {entries.map((entry, index) => (
          <div key={`${entry.webhookUrl}-${index}`} className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Web address</p>
              <div className="flex items-center gap-2">
                <Input value={entry.webhookUrl} readOnly className="flex-1" aria-label="Web address" />
                <Button variant="outline" size="sm" onClick={() => onCopy("Web address", entry.webhookUrl)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Password</p>
              <div className="flex items-center gap-2">
                <Input value={entry.webhookSecret} readOnly className="flex-1" aria-label="Password" />
                <Button variant="outline" size="sm" onClick={() => onCopy("Password", entry.webhookSecret)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
              <p className="text-xs font-medium text-foreground">
                You won't see it again — paste it into the other system now.
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

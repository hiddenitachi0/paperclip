import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shows backup codes one time. The caller decides when the person is done with them. */
export function BackupCodesPanel({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  async function copyAll() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-3" data-testid="backup-codes">
      <p className="text-sm text-muted-foreground">
        Keep these somewhere safe, like a password manager. Each one works once if you lose your phone.
        <strong className="text-foreground"> You will not see them again.</strong>
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border bg-code-background p-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="sm" onClick={copyAll}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? "Copied" : "Copy all"}
      </Button>
    </div>
  );
}

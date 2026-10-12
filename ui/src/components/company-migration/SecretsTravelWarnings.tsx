import { ShieldAlert } from "lucide-react";
import { SECRETS_TRAVEL_WARNINGS } from "../../lib/company-migration";

export function SecretsTravelWarnings() {
  return (
    <div
      className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
      data-testid="secrets-travel-warnings"
    >
      <div className="mb-1 flex items-center gap-1.5 font-medium">
        <ShieldAlert className="h-3.5 w-3.5" />
        Before you send secrets
      </div>
      <ul className="list-disc space-y-0.5 pl-5">
        {SECRETS_TRAVEL_WARNINGS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

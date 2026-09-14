import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "../lib/utils";
import {
  NO_SPENDING_LIMIT_CHOICE,
  NO_SPENDING_LIMIT_WARNING,
  SPENDING_LIMIT_EXPLANATION,
  SPENDING_LIMIT_HEADING,
  resolveSpendingLimitChoice,
  spendingLimitSummary,
} from "../lib/hire-spending-limit";

/**
 * DUR-3976: the monthly spending limit, set while employing someone rather
 * than remembered afterwards. Shown in dollars and pre-filled with the
 * standard $50. See ../lib/hire-spending-limit.ts for the rules and wording.
 */
export function SpendingLimitSection({
  dollarsText,
  onDollarsTextChange,
  noLimit,
  onNoLimitChange,
  disabled,
}: {
  dollarsText: string;
  onDollarsTextChange: (next: string) => void;
  noLimit: boolean;
  onNoLimitChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const choice = resolveSpendingLimitChoice({ dollarsText, noLimit });
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{SPENDING_LIMIT_HEADING}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{SPENDING_LIMIT_EXPLANATION}</p>
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex items-center rounded-md border border-border px-2 py-1.5",
            (disabled || noLimit) && "opacity-50",
          )}
        >
          <span className="text-sm text-muted-foreground" aria-hidden="true">$</span>
          <input
            aria-label={`${SPENDING_LIMIT_HEADING} in dollars`}
            className="w-24 bg-transparent pl-1 text-sm outline-none tabular-nums"
            inputMode="decimal"
            value={noLimit ? "" : dollarsText}
            placeholder={noLimit ? "none" : "50"}
            onChange={(e) => onDollarsTextChange(e.target.value)}
            disabled={disabled || noLimit}
          />
        </div>
        <span className="text-sm text-muted-foreground">a month</span>
      </div>
      <p
        className={cn(
          "mt-2 text-xs",
          choice.ok ? (choice.cents > 0 ? "text-muted-foreground" : "text-destructive") : "text-destructive",
        )}
        role={choice.ok && choice.cents > 0 ? undefined : "alert"}
      >
        {choice.ok
          ? choice.cents > 0
            ? `${spendingLimitSummary(choice.cents)}.`
            : `${spendingLimitSummary(0)}. ${NO_SPENDING_LIMIT_WARNING}`
          : choice.message}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Checkbox
          id="hire-no-spending-limit"
          checked={noLimit}
          onCheckedChange={(next) => onNoLimitChange(next === true)}
          disabled={disabled}
        />
        <label htmlFor="hire-no-spending-limit" className="text-xs text-muted-foreground">
          {NO_SPENDING_LIMIT_CHOICE}
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        You can change this later on this person's own page.
      </p>
    </div>
  );
}

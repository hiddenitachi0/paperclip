import { useId } from "react";
import {
  BRAG_ON_DONE_LENGTH_SECONDS,
  estimateBragOnDoneCostCents,
  resolveBragOnDoneMaxCostCents,
  type IssueBragPreapproval,
} from "@paperclipai/shared";

/**
 * The "Make a short brag video when this is done" tick box. Shown wherever a
 * person creates or edits a task. Only people use this screen; the server
 * also refuses the setting from agents, whatever path they use.
 */

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface BragOnDoneCompanySettings {
  bragOnDoneEnabled?: boolean;
  bragOnDoneMaxCostCents?: number | null;
}

export function bragOnDoneHelpText(company: BragOnDoneCompanySettings | null | undefined): string {
  const estimate = estimateBragOnDoneCostCents();
  const cap = resolveBragOnDoneMaxCostCents(company?.bragOnDoneMaxCostCents ?? null);
  return (
    `When the task is finished, Paperclip makes a short video (about ${BRAG_ON_DONE_LENGTH_SECONDS} seconds) ` +
    `showing what was done and posts the link on the task. It usually costs about ${dollars(estimate)} ` +
    `and never more than ${dollars(cap)} without asking you. It starts by itself once the task is done; ` +
    "you can untick this any time before then."
  );
}

export const BRAG_ON_DONE_TURNED_OFF_TEXT =
  "Brag videos for finished tasks are turned off for this company. An owner or admin can turn them on in Company settings.";

function outcomeText(pre: IssueBragPreapproval): string {
  switch (pre.outcome) {
    case "completed":
      return "The brag video for this task was made. The link is in the comments.";
    case "failed":
      return "The brag video could not be made. The reason is in the comments.";
    case "over_cap":
      return "The brag video would cost more than allowed. There is a question about it in the comments.";
    case "turned_off":
      return "No brag video was made because the feature was turned off.";
    default:
      return "The brag video is being made now.";
  }
}

export function BragOnDoneOption({
  company,
  checked,
  onCheckedChange,
  preapproval,
  taskDone = false,
  disabled = false,
}: {
  company: BragOnDoneCompanySettings | null | undefined;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The stored pre-approval, when editing an existing task. */
  preapproval?: IssueBragPreapproval | null;
  /** True once the task is done: the choice is locked then. */
  taskDone?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const turnedOff = company?.bragOnDoneEnabled === false;
  const used = Boolean(preapproval?.triggeredAt);
  const locked = used || taskDone;
  // An existing tick stays visible (so it can be unticked) even if the feature was turned off later.
  const boxDisabled = disabled || locked || (turnedOff && !checked);

  let help: string;
  if (used && preapproval) help = outcomeText(preapproval);
  else if (taskDone) help = checked
    ? "This task is done, so this can no longer be changed."
    : "This task is already done. A brag video can only be asked for before a task is finished.";
  else if (turnedOff) help = BRAG_ON_DONE_TURNED_OFF_TEXT;
  else help = bragOnDoneHelpText(company);

  return (
    <div className="flex items-start gap-2" data-testid="brag-on-done-option">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={boxDisabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        aria-describedby={`${id}-help`}
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={id} className="text-xs font-medium leading-snug">
          Make a short brag video when this is done
        </label>
        <p id={`${id}-help`} className="text-[11px] leading-snug text-muted-foreground">
          {help}
        </p>
      </div>
    </div>
  );
}

import { cn } from "../lib/utils";

/**
 * DUR-3971: the working-style choice, made while employing someone rather
 * than dug out afterwards.
 *
 * Internally this is the quick-agent flag (agents.lane_a_enabled), but the
 * operator is picturing a role, not a lane, so the choice is worded as what
 * the person does. "Goes away and works on tasks" is the default because it
 * is what every agent employed before this existed does, and because it is
 * the safer wrong answer: a working agent that should have been a quick one
 * still does the work, just slower, while a quick agent that should have
 * been a working one cannot take the job at all.
 */

export const WORKING_STYLE_OPTIONS = [
  {
    value: "works_on_tasks",
    title: "Goes away and works on tasks",
    line: "Give it a job and it works on its own for minutes or hours, then comes back with the result. It will not reply to you instantly.",
  },
  {
    value: "answers_in_chat",
    title: "Answers straight away in chat",
    line: "Replies in seconds, remembers the conversation and can pass work on to a colleague. It cannot take a job and work through it itself.",
  },
] as const;

export type WorkingStyle = (typeof WORKING_STYLE_OPTIONS)[number]["value"];

/** The default: unchanged from how every agent behaved before this choice existed. */
export const DEFAULT_WORKING_STYLE: WorkingStyle = "works_on_tasks";

/** Single place that translates the operator's words into the stored flag. */
export function answersStraightAwayInChat(style: WorkingStyle): boolean {
  return style === "answers_in_chat";
}

/**
 * The same two sentences, for anywhere the choice is read back (the hire
 * approval card, for one) so the board reads the words it was offered.
 * A hire card from before this choice existed has no flag, which reads as
 * false — correct, because that is exactly what those agents do.
 */
export function workingStyleTitle(laneAEnabled: boolean | undefined): string {
  return laneAEnabled === true ? WORKING_STYLE_OPTIONS[1].title : WORKING_STYLE_OPTIONS[0].title;
}

export function WorkingStyleSection({
  value,
  onChange,
  disabled,
}: {
  value: WorkingStyle;
  onChange: (next: WorkingStyle) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">How this person works</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Pick the one that matches the job you have in mind.
      </p>
      <div className="space-y-2" role="radiogroup" aria-label="How this person works">
        {WORKING_STYLE_OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                "w-full rounded-lg border p-3 text-left transition-colors",
                selected ? "border-foreground bg-accent/40" : "border-border hover:bg-accent/20",
                disabled && "opacity-50 cursor-not-allowed",
              )}
            >
              <span className="flex items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border",
                    selected ? "border-[5px] border-foreground" : "border-border",
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{option.title}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {option.line}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        You can change this later on this person's own page.
      </p>
    </div>
  );
}

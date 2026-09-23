import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import type { AgentLimits } from "@paperclipai/shared";
import { AGENT_LIMITS_NOTES_MAX_LENGTH } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { personasApi } from "../api/personas";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

// DUR-4000: the two job-side persona fields, shared by the agent settings
// form (AgentConfigForm, edit) and the New Agent page (create) so both say
// the same thing. A persona is a person; an agent is a job. The picker says
// who does this job; the limits box is the job's own.

const fieldClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm placeholder:text-muted-foreground/40";

/** Shown under the Tone field while a persona is attached. */
export const PERSONA_VOICE_WINS_HINT = "The persona's voice wins when it has one.";

export function PersonaPicker({
  companyId,
  value,
  onChange,
  disabled,
  className,
}: {
  companyId: string | null | undefined;
  value: string | null;
  onChange: (personaId: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const personasQuery = useQuery({
    queryKey: companyId ? queryKeys.personas.list(companyId) : ["personas", "__none__"],
    queryFn: () => personasApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const personas = personasQuery.data ?? [];
  // Keep the saved value selectable while the list is still loading, so the
  // select never silently flips to "None" and marks the form dirty.
  const knownIds = new Set(personas.map((persona) => persona.id));

  return (
    <div className="space-y-1">
      <select
        aria-label="Persona"
        className={cn(fieldClass, className)}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        disabled={disabled}
      >
        <option value="">None - a blank job</option>
        {value && !knownIds.has(value) ? <option value={value}>{personasQuery.isLoading ? "Loading..." : value}</option> : null}
        {personas.map((persona) => (
          <option key={persona.id} value={persona.id}>
            {persona.displayName}
            {persona.pronouns ? ` (${persona.pronouns})` : ""}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        The person doing this job. Not in the list?{" "}
        <Link to="/personas" className="underline underline-offset-2">
          Create one
        </Link>{" "}
        under Personas, then pick them here.
      </p>
    </div>
  );
}

function parseDailyLimit(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function LimitNumberField({
  id,
  label,
  enforced,
  value,
  onChange,
  disabled,
  className,
}: {
  id: string;
  label: string;
  enforced: boolean;
  value: number | null | undefined;
  onChange: (next: number | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </label>
        <Badge variant={enforced ? "default" : "outline"} className="px-1.5 py-0 text-[10px] font-medium">
          {enforced ? "Enforced" : "Guidance"}
        </Badge>
      </div>
      <input
        id={id}
        type="number"
        min={0}
        inputMode="numeric"
        className={cn(fieldClass, className)}
        placeholder="No limit"
        value={value ?? ""}
        onChange={(event) => {
          const parsed = parseDailyLimit(event.target.value);
          if (parsed === undefined) return;
          onChange(parsed);
        }}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * The job's limits box: what Paperclip enforces in code and what is guidance
 * the agent reads, said in plain words next to each field. `value` is the
 * whole agents.limits object; every change hands back the whole object so
 * the caller can PATCH it as one field.
 */
export function AgentLimitsFields({
  value,
  onChange,
  disabled,
  inputClassName,
}: {
  value: AgentLimits;
  onChange: (next: AgentLimits) => void;
  disabled?: boolean;
  inputClassName?: string;
}) {
  const idPrefix = useId();
  const notes = value.notes ?? "";

  function patch(next: Partial<AgentLimits>) {
    onChange({ ...value, ...next });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">Enforced</span> means Paperclip stops the agent in code when the
        limit is reached. <span className="font-medium text-foreground/80">Guidance</span> means the agent reads the limit
        and is expected to keep to it, but nothing stops it yet.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <LimitNumberField
          id={`${idPrefix}-images`}
          label="Pictures per day"
          enforced
          value={value.dailyImageGenerations}
          onChange={(next) => patch({ dailyImageGenerations: next })}
          disabled={disabled}
          className={inputClassName}
        />
        <LimitNumberField
          id={`${idPrefix}-posts`}
          label="Posts per day"
          enforced={false}
          value={value.dailyPosts}
          onChange={(next) => patch({ dailyPosts: next })}
          disabled={disabled}
          className={inputClassName}
        />
        <LimitNumberField
          id={`${idPrefix}-runs`}
          label="Runs per day"
          enforced={false}
          value={value.dailyRuns}
          onChange={(next) => patch({ dailyRuns: next })}
          disabled={disabled}
          className={inputClassName}
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <label htmlFor={`${idPrefix}-notes`} className="text-xs text-muted-foreground">
            Standing rules
          </label>
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
            Guidance
          </Badge>
        </div>
        <textarea
          id={`${idPrefix}-notes`}
          className={cn(fieldClass, "min-h-[64px] resize-y", inputClassName)}
          placeholder="Rules this agent should always keep to, e.g. do not repeat mistakes you made before; never promise a delivery date."
          value={notes}
          onChange={(event) => patch({ notes: event.target.value.slice(0, AGENT_LIMITS_NOTES_MAX_LENGTH) || null })}
          maxLength={AGENT_LIMITS_NOTES_MAX_LENGTH}
          disabled={disabled}
        />
        <div
          className={cn(
            "text-right text-xs",
            notes.length >= AGENT_LIMITS_NOTES_MAX_LENGTH ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {notes.length}/{AGENT_LIMITS_NOTES_MAX_LENGTH}
        </div>
      </div>
    </div>
  );
}

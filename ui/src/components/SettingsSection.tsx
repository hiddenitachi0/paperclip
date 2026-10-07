import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * A titled, collapsible block for long settings pages (agent Configuration,
 * Skills, Tools). Two levels:
 *
 * - `SettingsSection`: a top-level group with a section-title heading and the
 *   strong section frame, e.g. "Model and limits".
 * - `SettingsSubsection`: a lighter group inside a section, e.g. "Backups".
 *
 * Closed blocks stay mounted (only hidden), so half-typed fields inside keep
 * their value when a block is folded away.
 *
 * Open/closed is remembered per viewer in localStorage under `storageKey`
 * (a convenience only: when storage is unavailable the default applies).
 * `summary` is shown next to the heading while the block is closed, so a
 * collapsed block still says what is in it ("OpenRouter · qwen3.8-27b").
 */

const STORAGE_PREFIX = "paperclip.settingsSection.";

function readOpen(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // Storage blocked (private window, preview): use the default.
  }
  return fallback;
}

function writeOpen(storageKey: string | undefined, open: boolean) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + storageKey, open ? "1" : "0");
  } catch {
    // Ignore: remembering the state is optional.
  }
}

function usePersistedOpen(storageKey: string | undefined, defaultOpen: boolean) {
  const [open, setOpenState] = useState(() => readOpen(storageKey, defaultOpen));
  const setOpen = (next: boolean) => {
    setOpenState(next);
    writeOpen(storageKey, next);
  };
  return [open, setOpen] as const;
}

interface SettingsSectionProps {
  title: ReactNode;
  /** One plain sentence under the heading saying what the block is for. */
  description?: ReactNode;
  /** Shown beside the heading while closed. */
  summary?: ReactNode;
  /** Small buttons on the right of the heading row (always visible). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  /** Remember open/closed for this viewer; omit to always start at the default. */
  storageKey?: string;
  id?: string;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
  "data-testid"?: string;
}

export function SettingsSection({
  title,
  description,
  summary,
  actions,
  defaultOpen = true,
  storageKey,
  id,
  className,
  contentClassName,
  children,
  "data-testid": testId,
}: SettingsSectionProps) {
  const [open, setOpen] = usePersistedOpen(storageKey, defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section id={id} className={cn("space-y-3", className)} data-testid={testId} data-state={open ? "open" : "closed"}>
        <div className="flex items-start justify-between gap-3">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-2 text-left">
            {open ? (
              <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0">
              <span className="section-title block group-hover:underline group-hover:underline-offset-4">{title}</span>
              {!open && summary ? (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
              ) : null}
            </span>
          </CollapsibleTrigger>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
        <CollapsibleContent forceMount className="space-y-3 data-[state=closed]:hidden">
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          <div className={cn("section-box rounded-lg p-4 space-y-5", contentClassName)}>{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

interface SettingsSubsectionProps {
  title: ReactNode;
  description?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}

export function SettingsSubsection({
  title,
  description,
  summary,
  actions,
  defaultOpen = true,
  storageKey,
  className,
  children,
  "data-testid": testId,
}: SettingsSubsectionProps) {
  const [open, setOpen] = usePersistedOpen(storageKey, defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <div
        className={cn("space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0", className)}
        data-testid={testId}
        data-state={open ? "open" : "closed"}
      >
        <div className="flex items-start justify-between gap-3">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-2 text-left">
            {open ? (
              <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground group-hover:underline group-hover:underline-offset-4">
                {title}
              </span>
              {!open && summary ? (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
              ) : null}
            </span>
          </CollapsibleTrigger>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
        <CollapsibleContent forceMount className="space-y-3 data-[state=closed]:hidden">
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

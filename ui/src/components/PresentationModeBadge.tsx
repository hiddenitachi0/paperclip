import { usePresentationMode } from "../context/PresentationModeContext";
import { cn } from "../lib/utils";

/**
 * Fixed "● REC"-style indicator shown whenever presentation mode is on, so
 * it's unmistakable from a glance at a shared screen that masking is active
 * (and, just as importantly, that it's off when it should be on).
 */
export function PresentationModeBadge() {
  const { enabled } = usePresentationMode();
  if (!enabled) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed left-1/2 top-2 z-[300] flex -translate-x-1/2 items-center gap-1.5",
        "rounded-full border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-600",
        "shadow-sm backdrop-blur dark:text-red-400",
      )}
      role="status"
      aria-live="polite"
    >
      <span className="size-2 rounded-full bg-red-500 motion-safe:animate-pulse" aria-hidden="true" />
      Presentation mode
    </div>
  );
}

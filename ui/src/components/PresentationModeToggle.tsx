import { Radio } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePresentationMode } from "../context/PresentationModeContext";

type PresentationModeToggleVariant = "icon" | "menu-action";

interface PresentationModeToggleProps {
  className?: string;
  variant?: PresentationModeToggleVariant;
  onAfterToggle?: () => void;
}

const MENU_ACTION_DESCRIPTION =
  "Mask money, names, emails and keys on screen. Visual only — storage and permissions are unaffected.";

/**
 * Canonical presentation-mode toggle widget, mirroring ThemeToggle's
 * icon/menu-action split so the account menu row and any future compact
 * header affordance stay in sync (DUR-4466).
 */
export function PresentationModeToggle({
  className,
  variant = "icon",
  onAfterToggle,
}: PresentationModeToggleProps) {
  const { enabled, toggle } = usePresentationMode();
  const label = enabled ? "Turn off presentation mode" : "Turn on presentation mode";

  function handleClick() {
    toggle();
    onAfterToggle?.();
  }

  if (variant === "menu-action") {
    return (
      <button
        type="button"
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
          className,
        )}
        onClick={handleClick}
        aria-label={label}
        aria-pressed={enabled}
      >
        <span
          className={cn(
            "mt-0.5 rounded-lg border border-border bg-background/70 p-2",
            enabled ? "text-red-500" : "text-muted-foreground",
          )}
        >
          <Radio className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            {enabled ? "Presentation mode: On" : "Presentation mode"}
          </span>
          <span className="block text-xs text-muted-foreground">{MENU_ACTION_DESCRIPTION}</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={`${label} (Cmd/Ctrl+Shift+P)`}
      aria-pressed={enabled}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent",
        enabled ? "text-red-500" : "text-muted-foreground",
        className,
      )}
    >
      <Radio className="size-4" />
    </button>
  );
}

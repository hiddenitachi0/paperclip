import { EyeOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePresentationMode } from "../context/PresentationModeContext";

interface HiddenInPresentationModeProps {
  children: ReactNode;
  /** Shown on the placeholder, e.g. "Finance report" or "Cost table". */
  label?: string;
  className?: string;
}

/**
 * Wraps a whole panel that is mostly private (finance reports, cost tables,
 * mail contents) so presentation mode replaces it with a neutral placeholder
 * instead of relying on text-level masking alone. Reveal is per-panel and
 * resets the next time the component mounts — it never persists or reaches
 * the server (DUR-4466).
 */
export function HiddenInPresentationMode({ children, label, className }: HiddenInPresentationModeProps) {
  const { enabled } = usePresentationMode();
  const [revealed, setRevealed] = useState(false);

  if (!enabled || revealed) {
    return <>{children}</>;
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center",
        className,
      )}
    >
      <EyeOff className="size-5 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">Hidden in presentation mode</p>
      {label ? <p className="text-xs text-muted-foreground">{label}</p> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="reveal-panel"
        onClick={() => setRevealed(true)}
      >
        Reveal this panel
      </Button>
    </div>
  );
}

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme, type ThemePreference } from "../context/ThemeContext";

type ThemeToggleVariant = "icon" | "menu-action";

interface ThemeToggleProps {
  className?: string;
  /**
   * `icon` (default): compact icon button that cycles light → dark → system —
   * suitable for headers, floating chrome (e.g. the unauthenticated `/auth`
   * page), and any other surface that just wants a toggle affordance.
   *
   * `menu-action`: full-width row with a three-way Light / Dark / System
   * picker — matches the surrounding `MenuAction` rows in `SidebarAccountMenu`.
   */
  variant?: ThemeToggleVariant;
  /**
   * Called after a choice is made. Surfaces like a popover menu use this
   * to dismiss the menu once the user has acted.
   */
  onAfterToggle?: () => void;
}

interface ThemeOption {
  value: ThemePreference;
  label: string;
  /** Plain-language action for the icon button's accessible name. */
  action: string;
  icon: LucideIcon;
}

// Cycle order for the icon variant; also the order of the picker buttons.
const THEME_OPTIONS: ThemeOption[] = [
  { value: "light", label: "Light", action: "Switch to light mode", icon: Sun },
  { value: "dark", label: "Dark", action: "Switch to dark mode", icon: Moon },
  { value: "system", label: "System", action: "Follow system theme", icon: Monitor },
];

function optionFor(preference: ThemePreference): ThemeOption {
  return THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[2];
}

function nextOption(preference: ThemePreference): ThemeOption {
  const index = THEME_OPTIONS.findIndex((option) => option.value === preference);
  return THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length];
}

/**
 * Canonical theme-toggle widget. Both the signed-out `/auth` chrome and
 * the in-app account menu render through this component so the labels,
 * icons, and behaviour stay in sync as the theme model evolves.
 */
export function ThemeToggle({ className, variant = "icon", onAfterToggle }: ThemeToggleProps) {
  const { theme, preference, setTheme } = useTheme();
  const current = optionFor(preference);

  function choose(value: ThemePreference) {
    setTheme(value);
    onAfterToggle?.();
  }

  if (variant === "menu-action") {
    const description =
      preference === "system"
        ? `Following your system setting (currently ${theme}).`
        : "Light, dark, or follow your system setting.";
    return (
      <div className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left", className)}>
        <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <current.icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Appearance</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
          <span
            role="radiogroup"
            aria-label="Appearance"
            className="mt-2 grid grid-cols-3 gap-0.5 rounded-lg border border-border bg-background/70 p-0.5"
          >
            {THEME_OPTIONS.map((option) => {
              const active = option.value === preference;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={option.action}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    active
                      ? "bg-accent text-accent-foreground shadow-xs"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                  onClick={() => choose(option.value)}
                >
                  <option.icon className="size-3.5" aria-hidden="true" />
                  {option.label}
                </button>
              );
            })}
          </span>
        </span>
      </div>
    );
  }

  const next = nextOption(preference);
  const title = `Theme: ${current.label}. ${next.action}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => choose(next.value)}
      aria-label={next.action}
      title={title}
      className={cn("text-muted-foreground", className)}
    >
      <current.icon />
    </Button>
  );
}

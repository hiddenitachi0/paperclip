import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** The theme actually applied to the document. */
export type Theme = "light" | "dark";
/**
 * What the user chose in this browser. `system` follows the OS
 * `prefers-color-scheme` setting and is the default for a new browser.
 */
export type ThemePreference = Theme | "system";

interface ThemeContextValue {
  /** Resolved theme currently applied to `<html>`. */
  theme: Theme;
  /** Stored choice: an explicit theme, or `system`. */
  preference: ThemePreference;
  /** Persist a choice. `system` re-attaches the OS listener. */
  setTheme: (preference: ThemePreference) => void;
  /** Flip between light and dark as an explicit choice. */
  toggleTheme: () => void;
}

export const THEME_STORAGE_KEY = "paperclip.theme";
// Keep in sync with the pre-hydration script in ui/index.html and the
// `--background` tokens in ui/src/index.css.
const DARK_THEME_COLOR = "#16191c";
const LIGHT_THEME_COLOR = "#f3f5f8";
const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

interface ThemeState {
  preference: ThemePreference;
  theme: Theme;
  /**
   * Whether the user has chosen something in this browser. Until they do,
   * the preference is the implicit `system` default and nothing is written
   * to storage.
   */
  explicit: boolean;
}

function resolveThemeFromDocument(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readStoredPreference(): ThemePreference | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : null;
  } catch {
    return null;
  }
}

function readSystemTheme(): Theme | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ThemeState>(() => {
    const stored = readStoredPreference();
    return {
      preference: stored ?? "system",
      // Start from whatever the pre-hydration script in index.html already
      // applied so the first React render matches the first paint.
      theme: resolveThemeFromDocument(),
      explicit: stored !== null,
    };
  });

  const setTheme = useCallback((preference: ThemePreference) => {
    setState((current) => ({
      preference,
      theme: preference === "system" ? (readSystemTheme() ?? current.theme) : preference,
      explicit: true,
    }));
  }, []);

  const toggleTheme = useCallback(() => {
    setState((current) => {
      const next: Theme = current.theme === "dark" ? "light" : "dark";
      return { preference: next, theme: next, explicit: true };
    });
  }, []);

  useEffect(() => {
    applyTheme(state.theme);
    if (!state.explicit) return;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.preference);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [state]);

  // While the preference is `system`, follow OS-level `prefers-color-scheme`
  // changes so the UI flips alongside the OS theme without a reload.
  useEffect(() => {
    if (state.preference !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setState((current) =>
        current.preference === "system"
          ? { ...current, theme: event.matches ? "dark" : "light" }
          : current,
      );
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [state.preference]);

  const value = useMemo(
    () => ({
      theme: state.theme,
      preference: state.preference,
      setTheme,
      toggleTheme,
    }),
    [state.theme, state.preference, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

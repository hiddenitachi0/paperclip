import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// DUR-4466: presentation mode is purely a client-side display concern. Its
// state lives only in this browser's localStorage and is never sent to or
// read from the server — toggling it changes nothing about data storage,
// permissions, or what agents can see or do.
const STORAGE_KEY = "paperclip.presentationMode";

export interface PresentationModeSettings {
  enabled: boolean;
  strict: boolean;
  keepList: string[];
  extraMaskedNames: string[];
  extraHiddenPages: string[];
}

interface PresentationModeContextValue extends PresentationModeSettings {
  toggle: () => void;
  setEnabled: (enabled: boolean) => void;
  setStrict: (strict: boolean) => void;
  setKeepList: (names: string[]) => void;
  setExtraMaskedNames: (names: string[]) => void;
  setExtraHiddenPages: (pages: string[]) => void;
}

const DEFAULT_SETTINGS: PresentationModeSettings = {
  enabled: false,
  strict: false,
  keepList: [],
  extraMaskedNames: [],
  extraHiddenPages: [],
};

const PresentationModeContext = createContext<PresentationModeContextValue | undefined>(undefined);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function loadSettings(): PresentationModeSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PresentationModeSettings>;
    return {
      enabled: parsed.enabled === true,
      strict: parsed.strict === true,
      keepList: isStringArray(parsed.keepList) ? parsed.keepList : [],
      extraMaskedNames: isStringArray(parsed.extraMaskedNames) ? parsed.extraMaskedNames : [],
      extraHiddenPages: isStringArray(parsed.extraHiddenPages) ? parsed.extraHiddenPages : [],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: PresentationModeSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore local storage write failures in restricted environments.
  }
}

export function PresentationModeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PresentationModeSettings>(() => loadSettings());

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const toggle = useCallback(() => {
    setSettings((current) => ({ ...current, enabled: !current.enabled }));
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setSettings((current) => ({ ...current, enabled }));
  }, []);

  const setStrict = useCallback((strict: boolean) => {
    setSettings((current) => ({ ...current, strict }));
  }, []);

  const setKeepList = useCallback((keepList: string[]) => {
    setSettings((current) => ({ ...current, keepList }));
  }, []);

  const setExtraMaskedNames = useCallback((extraMaskedNames: string[]) => {
    setSettings((current) => ({ ...current, extraMaskedNames }));
  }, []);

  const setExtraHiddenPages = useCallback((extraHiddenPages: string[]) => {
    setSettings((current) => ({ ...current, extraHiddenPages }));
  }, []);

  // Keyboard shortcut: Cmd/Ctrl+Shift+P toggles presentation mode. This is
  // intentionally independent of the instance-wide "keyboard shortcuts"
  // admin setting — presentation mode is a personal, per-browser privacy
  // switch Filip needs to reach instantly mid-demo, not a navigation shortcut
  // an operator may have turned off.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if ((event.key === "p" || event.key === "P") && (event.metaKey || event.ctrlKey) && event.shiftKey) {
        event.preventDefault();
        setSettings((current) => ({ ...current, enabled: !current.enabled }));
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Cross-tab sync: flipping the switch in one tab should reflect in others
  // sharing the same browser profile.
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY) return;
      setSettings(loadSettings());
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const value = useMemo<PresentationModeContextValue>(
    () => ({
      ...settings,
      toggle,
      setEnabled,
      setStrict,
      setKeepList,
      setExtraMaskedNames,
      setExtraHiddenPages,
    }),
    [settings, toggle, setEnabled, setStrict, setKeepList, setExtraMaskedNames, setExtraHiddenPages],
  );

  return <PresentationModeContext.Provider value={value}>{children}</PresentationModeContext.Provider>;
}

export function usePresentationMode() {
  const context = useContext(PresentationModeContext);
  if (!context) {
    throw new Error("usePresentationMode must be used within PresentationModeProvider");
  }
  return context;
}

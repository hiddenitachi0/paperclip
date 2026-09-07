import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export interface GeneralSettingsContextValue {
  keyboardShortcutsEnabled: boolean;
  /**
   * DUR-411: opt-in stricter gate for the "fact check" confirmation card.
   * Defaults to false (today's denylist-only heuristic) when no provider is
   * mounted, so isolated renders and tests keep the current behaviour.
   */
  factCheckCardStrictAllowlist: boolean;
}

const GeneralSettingsContext = createContext<GeneralSettingsContextValue>({
  keyboardShortcutsEnabled: false,
  factCheckCardStrictAllowlist: false,
});

export function GeneralSettingsProvider({
  value,
  children,
}: {
  value: GeneralSettingsContextValue;
  children: ReactNode;
}) {
  return (
    <GeneralSettingsContext.Provider value={value}>
      {children}
    </GeneralSettingsContext.Provider>
  );
}

export function useGeneralSettings() {
  return useContext(GeneralSettingsContext);
}

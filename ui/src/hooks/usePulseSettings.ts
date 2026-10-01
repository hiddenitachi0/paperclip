import { useCallback, useEffect, useState } from "react";

const ENABLED_KEY = "paperclip.pulse.enabled";
const REFRESH_MS_KEY = "paperclip.pulse.refreshMs";
const TELEGRAM_KEY = "paperclip.pulse.telegramEnabled";

export const PULSE_REFRESH_OPTIONS_MS = [15_000, 30_000, 60_000, 300_000] as const;
export const PULSE_DEFAULT_REFRESH_MS = 30_000;

function readBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function readRefreshMs(): number {
  if (typeof window === "undefined") return PULSE_DEFAULT_REFRESH_MS;
  try {
    const stored = Number(window.localStorage.getItem(REFRESH_MS_KEY));
    if (PULSE_REFRESH_OPTIONS_MS.includes(stored as (typeof PULSE_REFRESH_OPTIONS_MS)[number])) {
      return stored;
    }
    return PULSE_DEFAULT_REFRESH_MS;
  } catch {
    return PULSE_DEFAULT_REFRESH_MS;
  }
}

/**
 * Pulse is off by default (per the pulse plan's gating requirement) and
 * everything here is a local, per-browser preference -- there is no backend
 * pulse-settings endpoint yet, so nothing syncs across devices.
 */
export function usePulseSettings() {
  const [enabled, setEnabledState] = useState(() => readBoolean(ENABLED_KEY, false));
  const [telegramEnabled, setTelegramEnabledState] = useState(() => readBoolean(TELEGRAM_KEY, false));
  const [refreshMs, setRefreshMsState] = useState(() => readRefreshMs());

  useEffect(() => {
    try {
      window.localStorage.setItem(ENABLED_KEY, String(enabled));
    } catch {
      // localStorage unavailable (private browsing, etc.) -- preference just won't persist.
    }
  }, [enabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TELEGRAM_KEY, String(telegramEnabled));
    } catch {
      // ignore
    }
  }, [telegramEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(REFRESH_MS_KEY, String(refreshMs));
    } catch {
      // ignore
    }
  }, [refreshMs]);

  const setEnabled = useCallback((next: boolean) => setEnabledState(next), []);
  const setTelegramEnabled = useCallback((next: boolean) => setTelegramEnabledState(next), []);
  const setRefreshMs = useCallback((next: number) => setRefreshMsState(next), []);

  return { enabled, setEnabled, telegramEnabled, setTelegramEnabled, refreshMs, setRefreshMs };
}

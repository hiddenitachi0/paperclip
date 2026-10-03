import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cacheSettingsApi, type CacheSettings } from "../api/cacheSettings";
import { queryKeys } from "../lib/queryKeys";
import { Field, ToggleField } from "./agent-config-primitives";

const DEFAULT_THRESHOLD_K = 150;
const THRESHOLD_MIN_K = 10;
const THRESHOLD_MAX_K = 2000;
const LIFETIME_MIN = 1;
const LIFETIME_MAX = 1440;

/** Saving agents' money by not re-reading long conversations after the provider forgets them. */
export function CacheSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const key = queryKeys.companies.cacheSettings(companyId);
  const { data: settings, error } = useQuery({
    queryKey: key,
    queryFn: () => cacheSettingsApi.get(companyId),
  });
  const [thresholdK, setThresholdK] = useState(String(DEFAULT_THRESHOLD_K));
  const [lifetime, setLifetime] = useState("");

  useEffect(() => {
    if (!settings) return;
    setThresholdK(String(Math.round(settings.handoffTokenThreshold / 1000)));
    setLifetime(settings.cacheLifetimeMinutes == null ? "" : String(settings.cacheLifetimeMinutes));
  }, [settings]);

  const mutation = useMutation({
    mutationFn: (patch: Partial<Omit<CacheSettings, "companyId">>) => cacheSettingsApi.update(companyId, patch),
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });

  const thresholdNum = Number.parseInt(thresholdK, 10);
  const thresholdValid =
    /^\d+$/.test(thresholdK.trim()) && thresholdNum >= THRESHOLD_MIN_K && thresholdNum <= THRESHOLD_MAX_K;
  const lifetimeTrim = lifetime.trim();
  const lifetimeNum = Number.parseInt(lifetimeTrim, 10);
  const lifetimeValid =
    lifetimeTrim === "" || (/^\d+$/.test(lifetimeTrim) && lifetimeNum >= LIFETIME_MIN && lifetimeNum <= LIFETIME_MAX);
  const dirty =
    !!settings &&
    (thresholdNum * 1000 !== settings.handoffTokenThreshold ||
      (lifetimeTrim === "" ? null : lifetimeNum) !== settings.cacheLifetimeMinutes);

  return (
    <div className="space-y-4" data-testid="company-settings-cache-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Saving money on long conversations
      </div>
      <div className="space-y-4 rounded-md border border-border px-4 py-3">
        <p className="text-sm text-muted-foreground">
          The AI provider briefly remembers a conversation after it is used. Picking it back up while it is
          remembered costs about a tenth as much. These settings help your agents take advantage of that.
        </p>
        {error && (
          <p className="text-xs text-destructive">
            Couldn't load these settings. {error instanceof Error ? error.message : ""}
          </p>
        )}
        {settings && (
          <>
            <ToggleField
              label="Save money on restarts"
              hint="The main switch. When it is off, agents work exactly as they did before and none of the options below do anything."
              checked={settings.enabled}
              onChange={(v) => mutation.mutate({ enabled: v })}
              toggleTestId="company-settings-cache-enabled-toggle"
            />
            <ToggleField
              label="Wake agents before the memory runs out"
              hint="If an agent is in the middle of a task and needs to be woken soon anyway, wake it while the provider still remembers the conversation. Agents that will sit idle for a long time are left alone, and we never pay to keep them awake."
              checked={settings.schedulingEnabled}
              onChange={(v) => mutation.mutate({ schedulingEnabled: v })}
              toggleTestId="company-settings-cache-scheduling-toggle"
            />
            <ToggleField
              label="Start fresh when a conversation gets huge"
              hint="When an agent wakes up with a very long conversation the provider has already forgotten, it starts a new conversation from a short written summary instead of paying to re-read everything."
              checked={settings.handoffEnabled}
              onChange={(v) => mutation.mutate({ handoffEnabled: v })}
              toggleTestId="company-settings-cache-handoff-toggle"
            />
            <Field
              label="How long is “huge”?"
              hint="Conversations longer than this, once forgotten by the provider, are restarted from a summary. A lower number restarts more often and costs less. A higher number keeps more history."
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="Conversation length before a fresh start, in thousands"
                  data-testid="company-settings-cache-threshold-input"
                  className="w-24 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={thresholdK}
                  onChange={(e) => setThresholdK(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">
                  thousand units (about {Math.round((thresholdNum || 0) * 0.75)} thousand words)
                </span>
              </div>
              {!thresholdValid && (
                <span className="text-xs text-destructive">
                  Enter a whole number from {THRESHOLD_MIN_K} to {THRESHOLD_MAX_K}.
                </span>
              )}
            </Field>
            <Field
              label="How long the provider remembers"
              hint="Only change this if your provider's memory time differs from the usual. Leave it empty and we use the usual time, which is 5 minutes, or 60 where the longer option applies."
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Usual"
                  aria-label="Minutes the provider remembers a conversation"
                  data-testid="company-settings-cache-lifetime-input"
                  className="w-24 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                  value={lifetime}
                  onChange={(e) => setLifetime(e.target.value)}
                />
                <span className="text-xs text-muted-foreground">minutes (empty = usual time)</span>
              </div>
              {!lifetimeValid && (
                <span className="text-xs text-destructive">
                  Leave empty, or enter a whole number from {LIFETIME_MIN} to {LIFETIME_MAX}.
                </span>
              )}
            </Field>
            {dirty && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  data-testid="company-settings-cache-save"
                  disabled={mutation.isPending || !thresholdValid || !lifetimeValid}
                  onClick={() =>
                    mutation.mutate({
                      handoffTokenThreshold: thresholdNum * 1000,
                      cacheLifetimeMinutes: lifetimeTrim === "" ? null : lifetimeNum,
                    })
                  }
                >
                  {mutation.isPending ? "Saving..." : "Save changes"}
                </Button>
              </div>
            )}
            {mutation.isError && (
              <span className="text-xs text-destructive">
                {mutation.error instanceof Error ? mutation.error.message : "Couldn't save. Try again."}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

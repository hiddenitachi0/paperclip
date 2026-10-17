import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS,
  BRAG_ON_DONE_LENGTH_SECONDS,
  BRAG_ON_DONE_MAX_COST_CENTS_LIMIT,
  estimateBragOnDoneCostCents,
} from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleField } from "./agent-config-primitives";

/**
 * Company settings: "Brag videos for finished tasks". The on/off switch for
 * the task tick box, and the most one such video may cost.
 */

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function parseDollarsToCents(value: string): number | null | "invalid" {
  const trimmed = value.trim().replace(/^\$/, "");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return "invalid";
  const cents = Math.round(n * 100);
  if (cents < 1 || cents > BRAG_ON_DONE_MAX_COST_CENTS_LIMIT) return "invalid";
  return cents;
}

export function BragOnDoneSettingsSection({
  company,
}: {
  company: { id: string; bragOnDoneEnabled?: boolean; bragOnDoneMaxCostCents?: number | null };
}) {
  const queryClient = useQueryClient();
  const enabled = company.bragOnDoneEnabled !== false;
  const savedCap = company.bragOnDoneMaxCostCents ?? null;
  const [capInput, setCapInput] = useState(savedCap === null ? "" : (savedCap / 100).toFixed(2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCapInput(savedCap === null ? "" : (savedCap / 100).toFixed(2));
  }, [savedCap]);

  const update = useMutation({
    mutationFn: (patch: { bragOnDoneEnabled?: boolean; bragOnDoneMaxCostCents?: number | null }) =>
      companiesApi.update(company.id, patch),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not save this setting."),
  });

  const parsed = parseDollarsToCents(capInput);
  const capChanged = parsed !== "invalid" && parsed !== savedCap;

  return (
    <div className="space-y-4" data-testid="company-settings-brag-on-done-section">
      <div className="section-title">Brag videos for finished tasks</div>
      <div className="rounded-md section-box px-4 py-3 space-y-3">
        <ToggleField
          label="Let people ask for a brag video when a task is done"
          hint={
            `Adds a "Make a short brag video when this is done" tick box to new tasks. When a ticked task is finished, ` +
            `Paperclip makes a short video (about ${BRAG_ON_DONE_LENGTH_SECONDS} seconds) about what was done and posts it on the task. ` +
            "Only people can tick it; agents never start brag videos by themselves. Turn off to hide the choice."
          }
          checked={enabled}
          onChange={(v) => update.mutate({ bragOnDoneEnabled: v })}
          toggleTestId="company-settings-brag-on-done-toggle"
        />
        <div className="space-y-1">
          <label htmlFor="brag-on-done-cap" className="text-xs text-muted-foreground">
            Most one video may cost (in dollars)
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="brag-on-done-cap"
              data-testid="company-settings-brag-on-done-cap"
              inputMode="decimal"
              className="h-8 w-28"
              placeholder={(BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS / 100).toFixed(2)}
              value={capInput}
              disabled={!enabled}
              onChange={(e) => setCapInput(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!enabled || !capChanged || update.isPending}
              onClick={() => {
                if (parsed === "invalid") return;
                update.mutate({ bragOnDoneMaxCostCents: parsed });
              }}
            >
              Save
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            A video usually costs about {dollars(estimateBragOnDoneCostCents())}. Leave empty to use the standard limit of{" "}
            {dollars(BRAG_ON_DONE_DEFAULT_MAX_COST_CENTS)}. If a video would cost more, Paperclip asks on the task first.
            The limit is saved on a task when someone ticks the box.
          </p>
          {parsed === "invalid" ? (
            <p className="text-[11px] text-destructive">
              Enter an amount between $0.01 and {dollars(BRAG_ON_DONE_MAX_COST_CENTS_LIMIT)}.
            </p>
          ) : null}
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

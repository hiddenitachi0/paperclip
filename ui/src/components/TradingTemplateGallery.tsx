import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { TRADING_ASSETS, type TradingAsset } from "@paperclipai/shared";
import { tradingApi, type TradingTemplateItem } from "../api/trading";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { familyWords, PAPER_ONLY_NOTE } from "../lib/tradingLeaderboard";
import { Button } from "@/components/ui/button";

/**
 * "Start from a template" (DUR-5016): a gallery of pre-written styles. Picking one
 * adds a paused play-money strategy with that style's rules, then opens the
 * rules editor already filled in. The status line under each style is the
 * server's own neutral wording; this screen never calls a style good.
 */

export function templateErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Your account cannot use the template gallery yet. Ask the instance owner.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again in a moment.";
}

function NoteList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium">{title}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function TemplateCard({
  template,
  busy,
  onPick,
}: {
  template: TradingTemplateItem;
  busy: boolean;
  onPick: (template: TradingTemplateItem, asset: TradingAsset) => void;
}) {
  const coins = template.assets.filter((a): a is TradingAsset => (TRADING_ASSETS as readonly string[]).includes(a));
  const [asset, setAsset] = useState<TradingAsset>(coins[0] ?? TRADING_ASSETS[0]);
  const [open, setOpen] = useState(false);
  const blocked = template.problems.length > 0;
  const selectId = `template-coin-${template.key}`;
  return (
    <li className="space-y-2 rounded-lg border border-border p-3" data-testid="template-card">
      <div className="space-y-0.5">
        <p className="font-medium">{template.name}</p>
        <p className="text-xs text-muted-foreground">{familyWords(template.family)}</p>
      </div>
      <p className="text-sm">{template.thesis}</p>
      <p className="text-xs text-muted-foreground" data-testid="template-status">
        {template.label.charAt(0).toUpperCase() + template.label.slice(1)}.
      </p>
      <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide details" : "Show when it works and when it does not"}
      </button>
      {open ? (
        <div className="space-y-2" data-testid="template-details">
          <NoteList title="Works best when" items={template.worksWhen} />
          <NoteList title="Struggles when" items={template.failsWhen} />
          <NoteList title="Left out of the original idea" items={template.simplifications} />
        </div>
      ) : null}
      {blocked ? (
        <p className="text-xs text-destructive">This style has a problem and cannot be used yet.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={selectId} className="text-xs text-muted-foreground">
            Coin
          </label>
          <select
            id={selectId}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={asset}
            onChange={(e) => setAsset(e.target.value as TradingAsset)}
            disabled={busy}
          >
            {coins.map((coin) => (
              <option key={coin} value={coin}>
                {coin}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => onPick(template, asset)} disabled={busy} aria-label={`Use ${template.name} for ${asset}`}>
            Use this style
          </Button>
        </div>
      )}
    </li>
  );
}

export function TradingTemplateGallery({
  companyId,
  onCreated,
  onError,
}: {
  companyId: string;
  /** Called with the new strategy's id once it exists; the page then opens its rules. */
  onCreated: (strategyId: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.trading.templates(companyId),
    queryFn: () => tradingApi.templates(companyId),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const create = useMutation({
    mutationFn: ({ template, asset }: { template: TradingTemplateItem; asset: TradingAsset }) =>
      tradingApi.createFromTemplate(companyId, { templateKey: template.key, asset }),
    onSuccess: (strategy) => onCreated(strategy.id),
    onError: (error) => onError(templateErrorMessage(error)),
  });

  const library = query.data;
  const styles = (library?.templates ?? []).filter((t) => t.family !== "control");
  const yardsticks = (library?.templates ?? []).filter((t) => t.family === "control");

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-labelledby="template-gallery-title" data-testid="template-gallery">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="template-gallery-title" className="text-sm font-semibold">
            Start from a template
          </h2>
          <p className="text-xs text-muted-foreground">Pick a style that is already written out. It opens with its rules filled in, and you can change anything before it runs.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide templates" : "Browse templates"}
        </Button>
      </div>

      {open ? (
        query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : query.error || !library ? (
          <p className="text-sm text-destructive">Could not load the templates. {query.error ? templateErrorMessage(query.error) : ""}</p>
        ) : (
          <div className="space-y-4">
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground" data-testid="template-note">
              These are starting points, not tips. Past results do not promise future ones, and every strategy still needs its own test on past data before it can run. {PAPER_ONLY_NOTE}
            </p>
            <ul className="grid gap-3 sm:grid-cols-2">
              {styles.map((template) => (
                <TemplateCard key={template.key} template={template} busy={create.isPending} onPick={(t, a) => create.mutate({ template: t, asset: a })} />
              ))}
            </ul>
            {yardsticks.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold">Yardsticks</h3>
                <p className="text-xs text-muted-foreground">Simple baselines. A real strategy only means something if it does better than these.</p>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {yardsticks.map((template) => (
                    <TemplateCard key={template.key} template={template} busy={create.isPending} onPick={(t, a) => create.mutate({ template: t, asset: a })} />
                  ))}
                </ul>
              </div>
            ) : null}
            {library.excluded.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold">Left out on purpose</h3>
                <ul className="space-y-2">
                  {library.excluded.map((style) => (
                    <li key={style.key} className="rounded-lg border border-dashed border-border p-3 opacity-60" aria-disabled="true" data-testid="template-excluded">
                      <p className="font-medium">{style.name}</p>
                      <p className="text-xs text-muted-foreground">{style.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}

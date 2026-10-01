import { useEffect, useMemo, useState } from "react";
import {
  WATCHER_CRYPTO_COINS,
  WATCHER_DEFAULT_CHECK_MINUTES,
  WATCHER_DEFAULT_COOLDOWN_MINUTES,
  WATCHER_DEFAULT_RULE,
  WATCHER_SOURCES,
  WATCHER_SOURCE_INFO,
  describeWatcherRule,
  watcherCheckEveryProblem,
  watcherRuleSchema,
  watcherSymbolName,
  watcherSymbolProblem,
  type Agent,
  type CreateWatcherInput,
  type WatcherRule,
  type WatcherSource,
  type WatcherSummary,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ADD_NEW_SECRET_LABEL, SecretBindingPicker } from "./SecretBindingPicker";

/**
 * Add or change a watcher, in plain words: what to watch, when to say
 * something ("Bitcoin moves 5% or more (up or down) within 24 hours"), who
 * says it, how often to look. The sentence under the rule is the same one
 * the server writes, so what the operator reads here is what the watcher
 * does. A key is only ever picked (or added) as a saved secret.
 */

const selectClass = "h-8 rounded-md border border-input bg-background px-2 text-sm";

const WINDOW_CHOICES: Array<{ hours: number; label: string }> = [
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
];

const CHECK_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 5, label: "every 5 minutes" },
  { minutes: 15, label: "every 15 minutes" },
  { minutes: 30, label: "every 30 minutes" },
  { minutes: 60, label: "every hour" },
  { minutes: 360, label: "every 6 hours" },
  { minutes: 720, label: "every 12 hours" },
  { minutes: 1440, label: "once a day" },
];

const QUIET_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: "no quiet time" },
  { minutes: 60, label: "1 hour" },
  { minutes: 180, label: "3 hours" },
  { minutes: 360, label: "6 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1440, label: "1 day" },
];

type RuleChoice = "change" | "level" | "since_last_alert";

export interface WatcherDraft {
  name: string;
  agentId: string;
  source: WatcherSource;
  symbol: string;
  ruleKind: RuleChoice;
  direction: "up" | "down" | "either";
  levelDirection: "above" | "below";
  percent: string;
  windowHours: number;
  price: string;
  checkEveryMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
  withPicture: boolean;
  keySecretId: string | null;
}

export function emptyWatcherDraft(agentId = ""): WatcherDraft {
  const rule = WATCHER_DEFAULT_RULE;
  return {
    name: "",
    agentId,
    source: "crypto",
    symbol: "BTC",
    ruleKind: "change",
    direction: rule.kind === "change" ? rule.direction : "either",
    levelDirection: "above",
    percent: String(rule.kind === "change" ? rule.percent : 5),
    windowHours: rule.kind === "change" ? rule.windowHours : 24,
    price: "",
    checkEveryMinutes: WATCHER_DEFAULT_CHECK_MINUTES,
    cooldownMinutes: WATCHER_DEFAULT_COOLDOWN_MINUTES,
    enabled: true,
    withPicture: false,
    keySecretId: null,
  };
}

export function draftFromWatcher(watcher: WatcherSummary): WatcherDraft {
  const draft = emptyWatcherDraft(watcher.agentId);
  // DUR-4168: a web-page watcher's rule has no change/level/since_last_alert shape to
  // edit here yet (that form is separate follow-up work) -- fall back to the default
  // rule rather than mis-type it as one of the three kinds this dialog understands.
  const rawRule = watcher.rule;
  const rule: WatcherRule =
    rawRule.kind === "change" || rawRule.kind === "level" || rawRule.kind === "since_last_alert"
      ? rawRule
      : WATCHER_DEFAULT_RULE;
  return {
    ...draft,
    name: watcher.name,
    source: watcher.source,
    symbol: watcher.symbol,
    ruleKind: rule.kind,
    direction: rule.kind === "change" ? rule.direction : draft.direction,
    levelDirection: rule.kind === "level" ? rule.direction : draft.levelDirection,
    percent: rule.kind === "level" ? draft.percent : String(rule.percent),
    windowHours: rule.kind === "change" ? rule.windowHours : draft.windowHours,
    price: rule.kind === "level" ? String(rule.price) : "",
    checkEveryMinutes: watcher.checkEveryMinutes,
    cooldownMinutes: watcher.cooldownMinutes,
    enabled: watcher.enabled,
    withPicture: watcher.withPicture,
    keySecretId: watcher.keySecretId,
  };
}

function toNumber(value: string): number {
  return Number(value.replace(",", ".").replace(/\s/g, ""));
}

/** The rule the draft describes, or a plain sentence saying what is missing. */
export function ruleFromDraft(draft: WatcherDraft): { rule: WatcherRule } | { problem: string } {
  const candidate =
    draft.ruleKind === "change"
      ? { kind: "change", direction: draft.direction, percent: toNumber(draft.percent), windowHours: draft.windowHours }
      : draft.ruleKind === "level"
        ? { kind: "level", direction: draft.levelDirection, price: toNumber(draft.price) }
        : { kind: "since_last_alert", percent: toNumber(draft.percent) };
  const parsed = watcherRuleSchema.safeParse(candidate);
  if (!parsed.success) {
    return { problem: parsed.error.issues[0]?.message ?? "Finish the rule." };
  }
  return { rule: parsed.data };
}

/** The request body for the draft, or a plain sentence saying what is missing. */
export function watcherInputFromDraft(draft: WatcherDraft): { input: CreateWatcherInput } | { problem: string } {
  const symbol = draft.symbol.trim().toUpperCase();
  const info = WATCHER_SOURCE_INFO[draft.source];
  const ruled = ruleFromDraft(draft);
  if ("problem" in ruled) return ruled;
  if (!draft.agentId) return { problem: "Pick the quick agent that sends the alerts." };
  const symbolProblem = watcherSymbolProblem(draft.source, symbol);
  if (symbolProblem) return { problem: symbolProblem };
  const everyProblem = watcherCheckEveryProblem(draft.source, draft.checkEveryMinutes);
  if (everyProblem) return { problem: everyProblem };
  if (info.needsKey && !draft.keySecretId) return { problem: `Pick the secret that holds your ${info.keyLabel}.` };
  const subject = watcherSymbolName(draft.source, symbol);
  return {
    input: {
      name: draft.name.trim() || describeWatcherRule(ruled.rule, subject, info.currency).slice(0, 80),
      agentId: draft.agentId,
      source: draft.source,
      symbol,
      rule: ruled.rule,
      checkEveryMinutes: draft.checkEveryMinutes,
      cooldownMinutes: draft.cooldownMinutes,
      enabled: draft.enabled,
      withPicture: draft.withPicture,
      keySecretId: info.needsKey ? draft.keySecretId : null,
    },
  };
}

interface WatcherFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watcher: WatcherSummary | null;
  quickAgents: Agent[];
  /** The key the last stock watcher of the same market used, offered first. */
  suggestedKeys: Partial<Record<WatcherSource, string>>;
  busy: boolean;
  onSubmit: (input: CreateWatcherInput) => void;
}

export function WatcherFormDialog({
  open,
  onOpenChange,
  watcher,
  quickAgents,
  suggestedKeys,
  busy,
  onSubmit,
}: WatcherFormDialogProps) {
  const [draft, setDraft] = useState<WatcherDraft>(() => emptyWatcherDraft(quickAgents[0]?.id ?? ""));
  const [shownProblem, setShownProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(watcher ? draftFromWatcher(watcher) : emptyWatcherDraft(quickAgents[0]?.id ?? ""));
    setShownProblem(null);
    // Only when the dialog opens or switches watcher; typing must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, watcher?.id]);

  const info = WATCHER_SOURCE_INFO[draft.source];
  const ruled = ruleFromDraft(draft);
  const subject = watcherSymbolName(draft.source, draft.symbol.trim().toUpperCase() || "…");
  const sentence = "rule" in ruled ? describeWatcherRule(ruled.rule, subject, info.currency) : null;
  const checkChoices = useMemo(
    () => CHECK_CHOICES.filter((choice) => choice.minutes >= info.minCheckMinutes),
    [info.minCheckMinutes],
  );

  function set<K extends keyof WatcherDraft>(key: K, value: WatcherDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function changeSource(source: WatcherSource) {
    const nextInfo = WATCHER_SOURCE_INFO[source];
    setDraft((prev) => ({
      ...prev,
      source,
      symbol: source === "crypto" ? "BTC" : source === "oslo_stock" ? "DNB" : "",
      checkEveryMinutes: Math.max(prev.checkEveryMinutes, nextInfo.minCheckMinutes),
      keySecretId: nextInfo.needsKey ? prev.keySecretId ?? suggestedKeys[source] ?? null : null,
    }));
  }

  function submit() {
    const built = watcherInputFromDraft(draft);
    if ("problem" in built) {
      setShownProblem(built.problem);
      return;
    }
    setShownProblem(null);
    onSubmit(built.input);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{watcher ? "Change watcher" : "New watcher"}</DialogTitle>
          <DialogDescription>
            A cheap check of a price. No AI is used to check; your quick agent only writes to you when the rule fires.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="watcher-source">What to watch</label>
            <div className="flex gap-2">
              <select
                id="watcher-source"
                className={selectClass}
                value={draft.source}
                onChange={(event) => changeSource(event.target.value as WatcherSource)}
                disabled={busy}
              >
                {WATCHER_SOURCES.map((source) => (
                  <option key={source} value={source} disabled={!WATCHER_SOURCE_INFO[source].available}>
                    {WATCHER_SOURCE_INFO[source].label}
                    {WATCHER_SOURCE_INFO[source].available ? "" : " (not available yet)"}
                  </option>
                ))}
              </select>
              {draft.source === "crypto" ? (
                <select
                  aria-label="Coin"
                  className={`${selectClass} flex-1`}
                  value={draft.symbol}
                  onChange={(event) => set("symbol", event.target.value)}
                  disabled={busy}
                >
                  {WATCHER_CRYPTO_COINS.map((coin) => (
                    <option key={coin.symbol} value={coin.symbol}>
                      {coin.name} ({coin.symbol})
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  aria-label="Ticker"
                  className="h-8 flex-1 uppercase"
                  placeholder={draft.source === "oslo_stock" ? "DNB" : "AAPL"}
                  value={draft.symbol}
                  onChange={(event) => set("symbol", event.target.value.toUpperCase())}
                  disabled={busy}
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">{info.note}</p>
          </div>

          {info.needsKey ? (
            <SecretBindingPicker
              label={info.keyLabel ?? "Key"}
              placeholder={`Pick the saved secret that holds your ${info.keyLabel}`}
              allowVersionSelector={false}
              value={draft.keySecretId ? { secretId: draft.keySecretId, version: "latest" } : null}
              onChange={(next) => set("keySecretId", next?.secretId ?? null)}
              disabled={busy}
              emptyHint={`No secrets yet. Pick "${ADD_NEW_SECRET_LABEL}" to paste the key without leaving this page.`}
            />
          ) : null}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="watcher-rule">When to tell you</label>
            <select
              id="watcher-rule"
              className={`${selectClass} w-full`}
              value={draft.ruleKind}
              onChange={(event) => set("ruleKind", event.target.value as RuleChoice)}
              disabled={busy}
            >
              <option value="change">When it moves by a percent within a time</option>
              <option value="level">When it goes above or below a price</option>
              <option value="since_last_alert">When it has moved by a percent since the last alert</option>
            </select>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{subject}</span>
              {draft.ruleKind === "change" ? (
                <>
                  <select
                    aria-label="Direction"
                    className={selectClass}
                    value={draft.direction}
                    onChange={(event) => set("direction", event.target.value as WatcherDraft["direction"])}
                    disabled={busy}
                  >
                    <option value="either">moves (up or down)</option>
                    <option value="up">rises</option>
                    <option value="down">falls</option>
                  </select>
                  <Input
                    aria-label="Percent"
                    className="h-8 w-20"
                    inputMode="decimal"
                    value={draft.percent}
                    onChange={(event) => set("percent", event.target.value)}
                    disabled={busy}
                  />
                  <span>% or more within</span>
                  <select
                    aria-label="Time window"
                    className={selectClass}
                    value={draft.windowHours}
                    onChange={(event) => set("windowHours", Number(event.target.value))}
                    disabled={busy}
                  >
                    {WINDOW_CHOICES.map((choice) => (
                      <option key={choice.hours} value={choice.hours}>{choice.label}</option>
                    ))}
                  </select>
                </>
              ) : draft.ruleKind === "level" ? (
                <>
                  <select
                    aria-label="Above or below"
                    className={selectClass}
                    value={draft.levelDirection}
                    onChange={(event) => set("levelDirection", event.target.value as WatcherDraft["levelDirection"])}
                    disabled={busy}
                  >
                    <option value="above">goes above</option>
                    <option value="below">goes below</option>
                  </select>
                  <Input
                    aria-label="Price"
                    className="h-8 w-32"
                    inputMode="decimal"
                    placeholder={info.currency === "USD" ? "100000" : "250"}
                    value={draft.price}
                    onChange={(event) => set("price", event.target.value)}
                    disabled={busy}
                  />
                  <span>{info.currency}</span>
                </>
              ) : (
                <>
                  <span>moves</span>
                  <Input
                    aria-label="Percent"
                    className="h-8 w-20"
                    inputMode="decimal"
                    value={draft.percent}
                    onChange={(event) => set("percent", event.target.value)}
                    disabled={busy}
                  />
                  <span>% or more since the last alert</span>
                </>
              )}
            </div>
            <p className="text-sm font-medium" data-testid="watcher-rule-sentence">
              {sentence ? `Tell me when ${sentence}.` : "Finish the rule above."}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="watcher-agent">Who tells you (on Telegram)</label>
            {quickAgents.length === 0 ? (
              <p className="text-sm text-destructive">
                No quick agent yet. Switch on quick answers for an agent on its page first.
              </p>
            ) : (
              <select
                id="watcher-agent"
                className={`${selectClass} w-full`}
                value={draft.agentId}
                onChange={(event) => set("agentId", event.target.value)}
                disabled={busy}
              >
                {quickAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            )}
            <p className="text-xs text-muted-foreground">
              The alert comes from this agent's Telegram bot, in its own words. One short AI call per alert.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="watcher-every">Look at the price</label>
              <select
                id="watcher-every"
                className={`${selectClass} w-full`}
                value={draft.checkEveryMinutes}
                onChange={(event) => set("checkEveryMinutes", Number(event.target.value))}
                disabled={busy}
              >
                {checkChoices.map((choice) => (
                  <option key={choice.minutes} value={choice.minutes}>{choice.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="watcher-quiet">Quiet after an alert</label>
              <select
                id="watcher-quiet"
                className={`${selectClass} w-full`}
                value={draft.cooldownMinutes}
                onChange={(event) => set("cooldownMinutes", Number(event.target.value))}
                disabled={busy}
              >
                {QUIET_CHOICES.map((choice) => (
                  <option key={choice.minutes} value={choice.minutes}>{choice.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm">Add a picture</div>
              <p className="text-xs text-muted-foreground">
                Made with Media Studio in the agent's look. Needs "Generate image" ticked on the agent's Tools tab; counts
                toward its daily picture limit.
              </p>
            </div>
            <ToggleSwitch
              aria-label="Add a picture"
              checked={draft.withPicture}
              onCheckedChange={(checked) => set("withPicture", checked)}
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="watcher-name">Name (optional)</label>
            <Input
              id="watcher-name"
              placeholder={sentence ?? "Bitcoin swings"}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
              disabled={busy}
            />
          </div>

          {shownProblem ? (
            <p className="text-sm text-destructive" role="alert">{shownProblem}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || quickAgents.length === 0}>
            {watcher ? "Save" : "Add watcher"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

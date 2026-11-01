import { useEffect, useId, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  DEFAULT_TRADING_RISK_CONFIG,
  TRADING_ASSETS,
  TRADING_GUIDELINES_MAX,
  TRADING_HARD_CEILING,
  TRADING_TIMEFRAMES,
  type TradingAsset,
  type TradingConditionGroup,
  type TradingIndicatorDefinition,
  type TradingOperand,
  type TradingStrategySpec,
  type TradingTimeframe,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  PRICE_FIELD_WORDS,
  TIMEFRAME_WORDS,
  describeStrategyInWords,
  indicatorPhrase,
} from "../lib/tradingSpecWords";

/**
 * The full strategy editor: eight plain-language sections, a read-back
 * sentence on top and the analyst notes at the bottom. It only edits a draft
 * held by the page; saving (and the approval card that follows) is the page's
 * job, so nothing here can change a running strategy.
 */

export const GUIDELINES_LABEL = "Notes for the analyst. The AI reads these to suggest rule changes; the trading code never reads them.";

type Spec = TradingStrategySpec;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function edit(spec: Spec, change: (draft: Spec) => void): Spec {
  const draft = structuredClone(spec);
  change(draft);
  return draft;
}

// ─── Small building blocks ─────────────────────────────────────────────────────

function Field({ label, hint, children, className }: { label: string; hint?: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function PickField<T extends string>({
  id,
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  id?: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function NumberField({
  id,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  ariaLabel,
}: {
  id?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((current) => (Number(current) === value && current.trim() !== "" ? current : String(value)));
  }, [value]);
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        aria-label={ariaLabel}
        type="number"
        inputMode="decimal"
        className="w-32"
        value={text}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
      />
      {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" className="h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Section({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-label={title}>
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{intro}</p>
      </div>
      {children}
    </section>
  );
}

// ─── What it watches: the measures ─────────────────────────────────────────────

const INDICATOR_KINDS: Array<{ kind: TradingIndicatorDefinition["kind"]; label: string; hint: string; make: () => TradingIndicatorDefinition }> = [
  { kind: "sma", label: "Average price", hint: "The average closing price over the last few candles.", make: () => ({ kind: "sma", period: 20 }) },
  { kind: "ema", label: "Smoothed average price", hint: "Like an average, but the newest candles count more.", make: () => ({ kind: "ema", period: 20 }) },
  { kind: "rsi", label: "Strength meter", hint: "A number from 0 to 100 showing how strongly the price has been rising or falling. Under 30 often means beaten down, over 70 means stretched up.", make: () => ({ kind: "rsi", period: 14 }) },
  { kind: "atr", label: "Average candle size (ATR)", hint: "ATR means the average size of a candle: how far the price usually moves in one candle.", make: () => ({ kind: "atr", period: 14 }) },
  { kind: "adx", label: "Trend strength", hint: "How strong a trend is, whichever way it goes. Above 25 usually means a clear trend.", make: () => ({ kind: "adx", period: 14, output: "adx" }) },
  { kind: "bb_width", label: "Width of the price channel", hint: "How wide the channel around the average price is. A narrow channel means a calm market.", make: () => ({ kind: "bb_width", period: 20, stdDev: 2 }) },
  { kind: "donchian", label: "Highest, lowest or middle price", hint: "The top, bottom or middle of the price range over the previous candles.", make: () => ({ kind: "donchian", period: 20, band: "upper" }) },
  { kind: "vwap", label: "Volume-weighted average price", hint: "The average price, where busy moments count more than quiet ones.", make: () => ({ kind: "vwap", anchor: "utc_day", lookback: 20 }) },
  { kind: "rvol", label: "How busy trading is", hint: "Trading compared with normal. 1 is normal, 2 is twice as busy.", make: () => ({ kind: "rvol", period: 20 }) },
  { kind: "roc", label: "Price change", hint: "How much the price has changed, in percent, over the last few candles.", make: () => ({ kind: "roc", period: 10 }) },
  { kind: "swing_high", label: "Recent high", hint: "The highest price of the last few candles.", make: () => ({ kind: "swing_high", lookback: 10 }) },
  { kind: "swing_low", label: "Recent low", hint: "The lowest price of the last few candles.", make: () => ({ kind: "swing_low", lookback: 10 }) },
];

function newIndicatorName(spec: Spec, kind: string): string {
  let n = 1;
  while (`${kind}_${n}` in spec.indicators) n += 1;
  return `${kind}_${n}`;
}

/** Everything in the rules that points at the measure `name`. */
function usesOfIndicator(spec: Spec, name: string): string[] {
  const uses: string[] = [];
  const inGroup = (group: TradingConditionGroup | undefined, where: string) => {
    group?.conditions.forEach((c) => {
      const operands: TradingOperand[] = [c.left, ...(c.op === "between" ? [c.low, c.high] : [c.right])];
      if (operands.some((o) => "ref" in o && o.ref === name) && !uses.includes(where)) uses.push(where);
    });
  };
  inGroup(spec.entry.conditions, "When it buys");
  inGroup(spec.exit.conditions, "When it sells");
  if (spec.exit.target?.kind === "level" && spec.exit.target.ref === name) uses.push("When it sells");
  return uses;
}

function IndicatorEditor({ name, def, spec, onChange, onRemove }: { name: string; def: TradingIndicatorDefinition; spec: Spec; onChange: (def: TradingIndicatorDefinition) => void; onRemove: () => void }) {
  const info = INDICATOR_KINDS.find((k) => k.kind === def.kind)!;
  const uses = usesOfIndicator(spec, name);
  const period = (label: string, value: number, apply: (n: number) => TradingIndicatorDefinition) => (
    <Field label={label} hint="Between 2 and 300.">
      {(id) => <NumberField id={id} value={value} min={2} max={300} onChange={(n) => onChange(apply(n))} suffix="candles" />}
    </Field>
  );
  return (
    <li className="space-y-3 rounded-md border border-border p-3" data-testid="strategy-measure">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{capitalize(indicatorPhrase(def))}</p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={uses.length > 0}
          aria-label={`Remove ${indicatorPhrase(def)}`}
          title={uses.length > 0 ? `It is used in "${uses.join('" and "')}". Take it out there first.` : undefined}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {uses.length > 0 ? <p className="text-xs text-muted-foreground">Used in “{uses.join("” and “")}”. Take it out there first to remove it.</p> : null}
      <Field label="What to measure" hint={info.hint}>
        {(id) => (
          <PickField
            id={id}
            value={def.kind}
            options={INDICATOR_KINDS.map((k) => ({ value: k.kind, label: k.label }))}
            onChange={(kind) => onChange(INDICATOR_KINDS.find((k) => k.kind === kind)!.make())}
          />
        )}
      </Field>
      {def.kind === "vwap" ? (
        <>
          <Field label="Starts counting from" hint="Either the start of each day (UTC), or the lowest price of the last few candles.">
            {(id) => (
              <PickField
                id={id}
                value={def.anchor}
                options={[
                  { value: "utc_day", label: "The start of each day" },
                  { value: "swing", label: "The recent lowest price" },
                ]}
                onChange={(anchor) => onChange({ ...def, anchor })}
              />
            )}
          </Field>
          {def.anchor === "swing" ? (
            <Field label="Look back over" hint="How many candles to search for the lowest price. Between 2 and 300.">
              {(id) => <NumberField id={id} value={def.lookback} min={2} max={300} onChange={(lookback) => onChange({ ...def, lookback })} suffix="candles" />}
            </Field>
          ) : null}
        </>
      ) : def.kind === "swing_high" || def.kind === "swing_low" ? (
        period("Look back over", def.lookback, (lookback) => ({ ...def, lookback }))
      ) : def.kind === "session_range" ? (
        <Field label="Opening stretch" hint="Set by the template this strategy came from. Change it by proposing a new version.">
          {() => (
            <span>
              The {def.band === "high" ? "highest" : "lowest"} price of the first {def.sessionBars} candle{def.sessionBars === 1 ? "" : "s"} after {String(def.anchorHourUtc).padStart(2, "0")}:00 UTC
            </span>
          )}
        </Field>
      ) : (
        period("Look back over", def.period, (p) => ({ ...def, period: p }))
      )}
      {def.kind === "adx" ? (
        <Field label="Which part" hint="The overall strength, or how hard the price is pushing up or down.">
          {(id) => (
            <PickField
              id={id}
              value={def.output}
              options={[
                { value: "adx", label: "How strong the trend is" },
                { value: "plus_di", label: "The upward push" },
                { value: "minus_di", label: "The downward push" },
              ]}
              onChange={(output) => onChange({ ...def, output })}
            />
          )}
        </Field>
      ) : null}
      {def.kind === "bb_width" ? (
        <Field label="Channel width" hint="How many standard swings wide the channel is. 2 is the usual choice. Between 0.5 and 5.">
          {(id) => <NumberField id={id} value={def.stdDev} min={0.5} max={5} step={0.5} onChange={(stdDev) => onChange({ ...def, stdDev })} />}
        </Field>
      ) : null}
      {def.kind === "donchian" ? (
        <Field label="Which line" hint="The top of the range, the bottom, or halfway between.">
          {(id) => (
            <PickField
              id={id}
              value={def.band}
              options={[
                { value: "upper", label: "The highest price" },
                { value: "lower", label: "The lowest price" },
                { value: "mid", label: "The middle" },
              ]}
              onChange={(band) => onChange({ ...def, band })}
            />
          )}
        </Field>
      ) : null}
    </li>
  );
}

// ─── Conditions ────────────────────────────────────────────────────────────────

type OperandKey = string; // "ref:name" | "price:close" | "number"

function operandKey(operand: TradingOperand): OperandKey {
  if ("ref" in operand) return `ref:${operand.ref}`;
  if ("price" in operand) return `price:${operand.price}`;
  return "number";
}

function operandFromKey(key: OperandKey, previous: TradingOperand): TradingOperand {
  if (key === "number") return "value" in previous ? previous : { value: 0 };
  if (key.startsWith("ref:")) return { ref: key.slice(4) };
  return { price: key.slice(6) as keyof typeof PRICE_FIELD_WORDS };
}

function OperandPicker({ value, spec, allowNumber, ariaLabel, onChange }: { value: TradingOperand; spec: Spec; allowNumber: boolean; ariaLabel: string; onChange: (operand: TradingOperand) => void }) {
  const options = [
    ...Object.entries(spec.indicators).map(([name, def]) => ({ value: `ref:${name}`, label: capitalize(indicatorPhrase(def)) })),
    ...(Object.keys(PRICE_FIELD_WORDS) as Array<keyof typeof PRICE_FIELD_WORDS>).map((p) => ({ value: `price:${p}`, label: capitalize(PRICE_FIELD_WORDS[p]) })),
    ...(allowNumber ? [{ value: "number", label: "A number" }] : []),
  ];
  const key = operandKey(value);
  const known = options.some((o) => o.value === key);
  return (
    <div className="space-y-2">
      <PickField ariaLabel={ariaLabel} value={known ? key : "__missing"} options={known ? options : [{ value: "__missing", label: "Pick something" }, ...options]} onChange={(next) => next !== "__missing" && onChange(operandFromKey(next, value))} />
      {"value" in value ? <NumberField ariaLabel={`${ariaLabel}: number`} value={value.value} step={0.1} onChange={(n) => onChange({ value: n })} /> : null}
    </div>
  );
}

const OPERATORS = [
  { value: "crosses_above", label: "moves up past" },
  { value: "crosses_below", label: "moves down past" },
  { value: ">", label: "is above" },
  { value: "<", label: "is below" },
  { value: "between", label: "is between" },
] as const;

function ConditionGroupEditor({ group, spec, onChange, minOne, what }: { group: TradingConditionGroup; spec: Spec; onChange: (group: TradingConditionGroup) => void; minOne: boolean; what: string }) {
  const firstRef = Object.keys(spec.indicators)[0];
  const setCondition = (index: number, next: TradingConditionGroup["conditions"][number]) => onChange({ ...group, conditions: group.conditions.map((c, i) => (i === index ? next : c)) });
  return (
    <div className="space-y-3">
      {group.conditions.length > 1 ? (
        <Field label={`${what} when`}>
          {(id) => (
            <PickField
              id={id}
              value={group.match}
              options={[
                { value: "all", label: "All of these are true" },
                { value: "any", label: "Any one of these is true" },
              ]}
              onChange={(match) => onChange({ ...group, match })}
            />
          )}
        </Field>
      ) : null}
      <ul className="space-y-3">
        {group.conditions.map((condition, index) => (
          <li key={index} className="space-y-2 rounded-md border border-border p-3" data-testid="strategy-condition">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Rule {index + 1}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={minOne && group.conditions.length === 1}
                aria-label={`Remove rule ${index + 1}`}
                onClick={() => onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <OperandPicker value={condition.left} spec={spec} allowNumber={false} ariaLabel={`Rule ${index + 1}: this`} onChange={(left) => setCondition(index, { ...condition, left } as typeof condition)} />
            <PickField
              ariaLabel={`Rule ${index + 1}: how`}
              value={condition.op}
              options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(op) => {
                if (op === "between") setCondition(index, { left: condition.left, op, low: { value: 0 }, high: { value: 100 } });
                else setCondition(index, { left: condition.left, op, right: condition.op === "between" ? { value: 0 } : condition.right });
              }}
            />
            {condition.op === "between" ? (
              <div className="space-y-2">
                <OperandPicker value={condition.low} spec={spec} allowNumber ariaLabel={`Rule ${index + 1}: lower end`} onChange={(low) => setCondition(index, { ...condition, low })} />
                <p className="text-xs text-muted-foreground">and</p>
                <OperandPicker value={condition.high} spec={spec} allowNumber ariaLabel={`Rule ${index + 1}: upper end`} onChange={(high) => setCondition(index, { ...condition, high })} />
              </div>
            ) : (
              <OperandPicker value={condition.right} spec={spec} allowNumber ariaLabel={`Rule ${index + 1}: compared with`} onChange={(right) => setCondition(index, { ...condition, right })} />
            )}
          </li>
        ))}
      </ul>
      {group.conditions.length < 12 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange({
              ...group,
              conditions: [...group.conditions, { left: firstRef ? { ref: firstRef } : { price: "close" }, op: ">", right: { value: 0 } }],
            })
          }
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add a rule
        </Button>
      ) : null}
    </div>
  );
}

// ─── The editor ────────────────────────────────────────────────────────────────

const FAMILY_OPTIONS = [
  { value: "trend", label: "Follows a trend" },
  { value: "breakout", label: "Buys a breakout" },
  { value: "mean_reversion", label: "Buys a dip back toward normal" },
  { value: "reversal", label: "Bets on a turnaround" },
  { value: "control", label: "A baseline to compare against" },
] as const;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface TradingStrategyEditorProps {
  mode: "create" | "edit";
  spec: Spec;
  guidelines: string;
  onSpecChange: (spec: Spec) => void;
  onGuidelinesChange: (guidelines: string) => void;
  /** Create only: the play money the strategy starts with. */
  startingCashNok?: number;
  onStartingCashChange?: (value: number) => void;
}

export function TradingStrategyEditor({ mode, spec, guidelines, onSpecChange, onGuidelinesChange, startingCashNok, onStartingCashChange }: TradingStrategyEditorProps) {
  const change = (fn: (draft: Spec) => void) => onSpecChange(edit(spec, fn));
  const indicatorEntries = Object.entries(spec.indicators);
  const risk = { ...DEFAULT_TRADING_RISK_CONFIG, ...spec.neverDo };
  const setRisk = <K extends keyof typeof risk>(key: K, value: (typeof risk)[K]) => change((d) => void ((d.neverDo as Record<string, unknown>)[key] = value));
  const exit = spec.exit;
  const stay = spec.stayOut;

  return (
    <div className="space-y-5" data-testid="strategy-editor">
      <div className="rounded-lg border border-border bg-muted/40 p-4" aria-live="polite">
        <h2 className="text-sm font-semibold">In plain words</h2>
        <p className="mt-1 text-sm" data-testid="strategy-read-back">
          {describeStrategyInWords(spec)}
        </p>
      </div>

      <Section title="About this strategy" intro="A name and the idea behind it.">
        {mode === "create" ? (
          <>
            <Field label="Name">
              {(id) => (
                <Input id={id} value={spec.meta.name} maxLength={120} placeholder="For example: Bitcoin trend follower" onChange={(e) => change((d) => void (d.meta.name = e.target.value))} />
              )}
            </Field>
            <Field label="Coin" hint="A strategy trades one coin. It cannot be changed later.">
              {(id) => (
                <PickField id={id} value={spec.universe.assets[0] ?? "BTC"} options={TRADING_ASSETS.map((a) => ({ value: a, label: a }))} onChange={(asset: TradingAsset) => change((d) => void (d.universe.assets = [asset]))} />
              )}
            </Field>
            <Field label="How often it decides" hint="The size of each candle it looks at. It cannot be changed later.">
              {(id) => (
                <PickField
                  id={id}
                  value={spec.universe.decisionTimeframe}
                  options={TRADING_TIMEFRAMES.map((t) => ({ value: t, label: `Every ${TIMEFRAME_WORDS[t]} candle` }))}
                  onChange={(t: TradingTimeframe) => change((d) => void (d.universe.decisionTimeframe = t))}
                />
              )}
            </Field>
            {onStartingCashChange && startingCashNok !== undefined ? (
              <Field label="Starting play money" hint="Pretend money only. No real money is ever used.">
                {(id) => <NumberField id={id} value={startingCashNok} min={1} max={TRADING_HARD_CEILING.maxTotalExposureNok} onChange={onStartingCashChange} suffix="NOK" />}
              </Field>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {spec.meta.name} trades {spec.universe.assets.join(", ")} on {TIMEFRAME_WORDS[spec.universe.decisionTimeframe]} candles. The coin and the candle size stay the same for the life of a strategy.
          </p>
        )}
        <Field label="Style">
          {(id) => <PickField id={id} value={spec.meta.family} options={[...FAMILY_OPTIONS]} onChange={(family) => change((d) => void (d.meta.family = family))} />}
        </Field>
        <Field label="Why should this work, and when would it fail?" hint="A few sentences in your own words.">
          {(id) => <Textarea id={id} rows={3} maxLength={2000} value={spec.meta.thesis} onChange={(e) => change((d) => void (d.meta.thesis = e.target.value))} />}
        </Field>
      </Section>

      <Section title="What it watches" intro="The things it measures before it decides. Each one can be used in the rules below.">
        <ul className="space-y-3">
          {indicatorEntries.map(([name, def]) => (
            <IndicatorEditor
              key={name}
              name={name}
              def={def}
              spec={spec}
              onChange={(next) => change((d) => void (d.indicators[name] = next))}
              onRemove={() => change((d) => void delete d.indicators[name])}
            />
          ))}
        </ul>
        {indicatorEntries.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet. The rules can still use the price itself.</p> : null}
        {indicatorEntries.length < 16 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              change((d) => {
                d.indicators[newIndicatorName(d, "sma")] = { kind: "sma", period: 20 };
              })
            }
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add something to measure
          </Button>
        ) : null}
      </Section>

      <Section title="When it buys" intro="It buys when these rules are true at the end of a candle.">
        <ConditionGroupEditor group={spec.entry.conditions} spec={spec} minOne what="Buy" onChange={(group) => change((d) => void (d.entry.conditions = group))} />
      </Section>

      <Section title="When it sells" intro="After a buy, it sells as soon as any one of these happens. It needs at least one.">
        <div className="space-y-4">
          <Field label="Safety stop" hint="Sells if the price falls this far, so one bad trade cannot grow.">
            {(id) => (
              <PickField
                id={id}
                value={exit.stop?.kind ?? "none"}
                options={[
                  { value: "none", label: "No safety stop" },
                  { value: "pct", label: "A set percent below what it paid" },
                  { value: "atr", label: "A few average candle sizes below what it paid" },
                  { value: "below_swing", label: "Just under the recent low" },
                ]}
                onChange={(kind) =>
                  change((d) => {
                    if (kind === "none") delete d.exit.stop;
                    else if (kind === "pct") d.exit.stop = { kind: "pct", pct: 3 };
                    else if (kind === "atr") d.exit.stop = { kind: "atr", period: 14, multiple: 2 };
                    else d.exit.stop = { kind: "below_swing", lookback: 10, bufferPct: 0 };
                  })
                }
              />
            )}
          </Field>
          {exit.stop?.kind === "pct" ? (
            <Field label="How far it may fall" hint="Percent below the price it paid. Up to 50.">
              {(id) => <NumberField id={id} value={exit.stop?.kind === "pct" ? exit.stop.pct : 0} min={0.1} max={50} step={0.1} suffix="%" onChange={(pct) => change((d) => void (d.exit.stop = { kind: "pct", pct }))} />}
            </Field>
          ) : null}
          {exit.stop?.kind === "atr" ? (
            <>
              <Field label="Average candle size measured over" hint="ATR is the average size of a candle. Between 2 and 100 candles.">
                {(id) => <NumberField id={id} value={exit.stop?.kind === "atr" ? exit.stop.period : 14} min={2} max={100} suffix="candles" onChange={(period) => change((d) => void (d.exit.stop?.kind === "atr" && (d.exit.stop.period = period)))} />}
              </Field>
              <Field label="How many candle sizes it may fall" hint="For example 2 means: twice the usual size of a candle. Up to 10.">
                {(id) => <NumberField id={id} value={exit.stop?.kind === "atr" ? exit.stop.multiple : 2} min={0.1} max={10} step={0.1} onChange={(multiple) => change((d) => void (d.exit.stop?.kind === "atr" && (d.exit.stop.multiple = multiple)))} />}
              </Field>
            </>
          ) : null}
          {exit.stop?.kind === "below_swing" ? (
            <>
              <Field label="Recent low looked at over" hint="Between 2 and 200 candles.">
                {(id) => <NumberField id={id} value={exit.stop?.kind === "below_swing" ? exit.stop.lookback : 10} min={2} max={200} suffix="candles" onChange={(lookback) => change((d) => void (d.exit.stop?.kind === "below_swing" && (d.exit.stop.lookback = lookback)))} />}
              </Field>
              <Field label="Extra room below that low" hint="A little margin so a tiny dip does not trigger it. Up to 10.">
                {(id) => <NumberField id={id} value={exit.stop?.kind === "below_swing" ? exit.stop.bufferPct : 0} min={0} max={10} step={0.1} suffix="%" onChange={(bufferPct) => change((d) => void (d.exit.stop?.kind === "below_swing" && (d.exit.stop.bufferPct = bufferPct)))} />}
              </Field>
            </>
          ) : null}

          <Field label="Profit goal" hint="Sells to lock in a gain once it is reached.">
            {(id) => (
              <PickField
                id={id}
                value={exit.target?.kind ?? "none"}
                options={[
                  { value: "none", label: "No profit goal" },
                  { value: "r_multiple", label: "A multiple of what it risked" },
                  { value: "pct", label: "A set percent above what it paid" },
                  { value: "level", label: "When the price reaches one of the measures" },
                ]}
                onChange={(kind) =>
                  change((d) => {
                    if (kind === "none") delete d.exit.target;
                    else if (kind === "r_multiple") d.exit.target = { kind: "r_multiple", multiple: 2 };
                    else if (kind === "pct") d.exit.target = { kind: "pct", pct: 5 };
                    else d.exit.target = { kind: "level", ref: Object.keys(d.indicators)[0] ?? "" };
                  })
                }
              />
            )}
          </Field>
          {exit.target?.kind === "r_multiple" ? (
            <Field label="How many times what it risked" hint="What it risks is the distance to the safety stop. 2 means it aims to gain twice that. Needs a safety stop.">
              {(id) => <NumberField id={id} value={exit.target?.kind === "r_multiple" ? exit.target.multiple : 2} min={0.1} max={20} step={0.1} onChange={(multiple) => change((d) => void (d.exit.target = { kind: "r_multiple", multiple }))} />}
            </Field>
          ) : null}
          {exit.target?.kind === "pct" ? (
            <Field label="How much above what it paid" hint="Percent. Up to 500.">
              {(id) => <NumberField id={id} value={exit.target?.kind === "pct" ? exit.target.pct : 5} min={0.1} max={500} step={0.1} suffix="%" onChange={(pct) => change((d) => void (d.exit.target = { kind: "pct", pct }))} />}
            </Field>
          ) : null}
          {exit.target?.kind === "level" ? (
            <Field label="Sell when the price reaches" hint="One of the things it measures.">
              {(id) => (
                <PickField
                  id={id}
                  value={exit.target?.kind === "level" ? exit.target.ref : ""}
                  options={[{ value: "", label: "Pick a measure" }, ...indicatorEntries.map(([name, def]) => ({ value: name, label: capitalize(indicatorPhrase(def)) }))]}
                  onChange={(ref) => change((d) => void (d.exit.target = { kind: "level", ref }))}
                />
              )}
            </Field>
          ) : null}

          <div className="space-y-2">
            <Toggle
              label="Follow the price up with a moving stop"
              checked={exit.trailing !== undefined}
              onChange={(on) => change((d) => void (on ? (d.exit.trailing = { activateAtPct: 2, distancePct: 1.5 }) : delete d.exit.trailing))}
            />
            {exit.trailing ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Starts once it is up" hint="Percent above what it paid.">
                  {(id) => <NumberField id={id} value={exit.trailing!.activateAtPct} min={0} max={100} step={0.1} suffix="%" onChange={(activateAtPct) => change((d) => void (d.exit.trailing && (d.exit.trailing.activateAtPct = activateAtPct)))} />}
                </Field>
                <Field label="Sells when it drops back by" hint="Percent below the highest price since buying.">
                  {(id) => <NumberField id={id} value={exit.trailing!.distancePct} min={0.1} max={50} step={0.1} suffix="%" onChange={(distancePct) => change((d) => void (d.exit.trailing && (d.exit.trailing.distancePct = distancePct)))} />}
                </Field>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Toggle
              label="Sell after a set time at the latest"
              checked={exit.timeStopBars !== undefined}
              onChange={(on) => change((d) => void (on ? (d.exit.timeStopBars = 24) : delete d.exit.timeStopBars))}
            />
            {exit.timeStopBars !== undefined ? (
              <Field label="Sell after" hint="Counted in candles. Up to 1000.">
                {(id) => <NumberField id={id} value={exit.timeStopBars!} min={1} max={1000} suffix="candles" onChange={(n) => change((d) => void (d.exit.timeStopBars = n))} />}
              </Field>
            ) : null}
          </div>

          <div className="space-y-2">
            <Toggle
              label="Also sell when other rules are true"
              checked={exit.conditions !== undefined}
              onChange={(on) =>
                change((d) => {
                  if (!on) delete d.exit.conditions;
                  else {
                    const first = Object.keys(d.indicators)[0];
                    d.exit.conditions = { match: "all", conditions: [{ left: first ? { ref: first } : { price: "close" }, op: "<", right: { value: 0 } }] };
                  }
                })
              }
            />
            {exit.conditions ? <ConditionGroupEditor group={exit.conditions} spec={spec} minOne what="Sell" onChange={(group) => change((d) => void (d.exit.conditions = group))} /> : null}
          </div>
        </div>
      </Section>

      <Section title="When it stays out" intro="Reasons to skip buying even when the buy rules are true. All of these are optional.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Direction of the market">
            {(id) => (
              <PickField
                id={id}
                value={spec.regimeGate.trend}
                options={[
                  { value: "any", label: "Any" },
                  { value: "up", label: "Only when going up" },
                  { value: "down", label: "Only when going down" },
                  { value: "range", label: "Only when moving sideways" },
                ]}
                onChange={(trend) => change((d) => void (d.regimeGate.trend = trend))}
              />
            )}
          </Field>
          <Field label="How much prices are moving">
            {(id) => (
              <PickField
                id={id}
                value={spec.regimeGate.volatility}
                options={[
                  { value: "any", label: "Any" },
                  { value: "low", label: "Only when a little" },
                  { value: "normal", label: "Only when normal" },
                  { value: "high", label: "Only when a lot" },
                ]}
                onChange={(volatility) => change((d) => void (d.regimeGate.volatility = volatility))}
              />
            )}
          </Field>
          <Field label="Squeezed into a narrow range" hint="Prices that have been very quiet, often before a big move.">
            {(id) => (
              <PickField
                id={id}
                value={spec.regimeGate.squeeze}
                options={[
                  { value: "any", label: "Doesn't matter" },
                  { value: "yes", label: "Only when squeezed" },
                  { value: "no", label: "Never when squeezed" },
                ]}
                onChange={(squeeze) => change((d) => void (d.regimeGate.squeeze = squeeze))}
              />
            )}
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Times of day it does not buy</p>
          {stay.blackoutWindows.map((w, index) => (
            <div key={index} className="space-y-2 rounded-md border border-border p-3" data-testid="strategy-quiet-time">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {DAY_NAMES.map((name, day) => (
                  <label key={name} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={w.days.includes(day)}
                      onChange={(e) =>
                        change((d) => {
                          const target = d.stayOut.blackoutWindows[index]!;
                          target.days = e.target.checked ? [...target.days, day].sort() : target.days.filter((x) => x !== day);
                        })
                      }
                    />
                    {name}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">No day ticked means every day. Hours are in UTC, the world clock.</p>
              <div className="flex flex-wrap items-center gap-2">
                <NumberField ariaLabel={`Quiet time ${index + 1}: from hour`} value={w.startHourUtc} min={0} max={23} onChange={(n) => change((d) => void (d.stayOut.blackoutWindows[index]!.startHourUtc = n))} suffix="o'clock to" />
                <NumberField ariaLabel={`Quiet time ${index + 1}: to hour`} value={w.endHourUtc} min={0} max={24} onChange={(n) => change((d) => void (d.stayOut.blackoutWindows[index]!.endHourUtc = n))} suffix="o'clock" />
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove quiet time ${index + 1}`} onClick={() => change((d) => void d.stayOut.blackoutWindows.splice(index, 1))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          {stay.blackoutWindows.length < 8 ? (
            <Button type="button" variant="outline" size="sm" onClick={() => change((d) => void d.stayOut.blackoutWindows.push({ days: [], startHourUtc: 0, endHourUtc: 6 }))}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add a quiet time
            </Button>
          ) : null}
        </div>

        <div className="space-y-2">
          <Toggle label="Take a break after several losses in a row" checked={stay.cooldownAfterLosses !== undefined} onChange={(on) => change((d) => void (on ? (d.stayOut.cooldownAfterLosses = { losses: 3, bars: 12 }) : delete d.stayOut.cooldownAfterLosses))} />
          {stay.cooldownAfterLosses ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Number of losses in a row">
                {(id) => <NumberField id={id} value={stay.cooldownAfterLosses!.losses} min={1} max={20} onChange={(n) => change((d) => void (d.stayOut.cooldownAfterLosses && (d.stayOut.cooldownAfterLosses.losses = n)))} />}
              </Field>
              <Field label="Length of the break" hint="Counted in candles.">
                {(id) => <NumberField id={id} value={stay.cooldownAfterLosses!.bars} min={1} max={1000} suffix="candles" onChange={(n) => change((d) => void (d.stayOut.cooldownAfterLosses && (d.stayOut.cooldownAfterLosses.bars = n)))} />}
              </Field>
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Toggle label="Wait for busy trading" checked={stay.minRelativeVolume !== undefined} onChange={(on) => change((d) => void (on ? (d.stayOut.minRelativeVolume = 1) : delete d.stayOut.minRelativeVolume))} />
          {stay.minRelativeVolume !== undefined ? (
            <Field label="At least this busy" hint="1 is normal trading, 2 is twice as busy.">
              {(id) => <NumberField id={id} value={stay.minRelativeVolume!} min={0} max={20} step={0.1} onChange={(n) => change((d) => void (d.stayOut.minRelativeVolume = n))} />}
            </Field>
          ) : null}
        </div>

        <div className="space-y-2">
          <Toggle label="Skip when buying and selling prices are far apart" checked={stay.maxSpreadPct !== undefined} onChange={(on) => change((d) => void (on ? (d.stayOut.maxSpreadPct = 0.2) : delete d.stayOut.maxSpreadPct))} />
          {stay.maxSpreadPct !== undefined ? (
            <Field label="Skip when the gap is more than" hint="Percent of the price. A wide gap makes trading more expensive.">
              {(id) => <NumberField id={id} value={stay.maxSpreadPct!} min={0.01} max={10} step={0.01} suffix="%" onChange={(n) => change((d) => void (d.stayOut.maxSpreadPct = n))} />}
            </Field>
          ) : null}
        </div>

        <div className="space-y-2">
          <Toggle label="Do not buy right after a sudden jump" checked={stay.noEntryAfterJump !== undefined} onChange={(on) => change((d) => void (on ? (d.stayOut.noEntryAfterJump = { jumpPct: 5, bars: 3 }) : delete d.stayOut.noEntryAfterJump))} />
          {stay.noEntryAfterJump ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="A jump counts from" hint="Percent move in one candle.">
                {(id) => <NumberField id={id} value={stay.noEntryAfterJump!.jumpPct} min={0.1} max={100} step={0.1} suffix="%" onChange={(n) => change((d) => void (d.stayOut.noEntryAfterJump && (d.stayOut.noEntryAfterJump.jumpPct = n)))} />}
              </Field>
              <Field label="Then it waits for" hint="Counted in candles.">
                {(id) => <NumberField id={id} value={stay.noEntryAfterJump!.bars} min={1} max={50} suffix="candles" onChange={(n) => change((d) => void (d.stayOut.noEntryAfterJump && (d.stayOut.noEntryAfterJump.bars = n)))} />}
              </Field>
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="Never do" intro="Hard limits. The trading code checks every order against them. They can only go as high as the system-wide ceiling shown under each box.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Most to put in one buy" hint={`Highest allowed: ${TRADING_HARD_CEILING.maxPositionNok.toLocaleString("nb-NO")} NOK.`}>
            {(id) => <NumberField id={id} value={risk.maxPositionNok} min={1} max={TRADING_HARD_CEILING.maxPositionNok} suffix="NOK" onChange={(n) => setRisk("maxPositionNok", n)} />}
          </Field>
          <Field label="Most to hold in total" hint={`Highest allowed: ${TRADING_HARD_CEILING.maxTotalExposureNok.toLocaleString("nb-NO")} NOK.`}>
            {(id) => <NumberField id={id} value={risk.maxTotalExposureNok} min={1} max={TRADING_HARD_CEILING.maxTotalExposureNok} suffix="NOK" onChange={(n) => setRisk("maxTotalExposureNok", n)} />}
          </Field>
          <Field label="Most orders in a day" hint={`Highest allowed: ${TRADING_HARD_CEILING.maxOrdersPerDay}.`}>
            {(id) => <NumberField id={id} value={risk.maxOrdersPerDay} min={1} max={TRADING_HARD_CEILING.maxOrdersPerDay} onChange={(n) => setRisk("maxOrdersPerDay", n)} />}
          </Field>
          <Field label="Stop buying after losing this much in a day" hint={`Highest allowed: ${TRADING_HARD_CEILING.dailyLossLimitNok.toLocaleString("nb-NO")} NOK.`}>
            {(id) => <NumberField id={id} value={risk.dailyLossLimitNok} min={1} max={TRADING_HARD_CEILING.dailyLossLimitNok} suffix="NOK" onChange={(n) => setRisk("dailyLossLimitNok", n)} />}
          </Field>
          <Field label="Stop buying after falling this far from its best" hint={`Percent. Highest allowed: ${TRADING_HARD_CEILING.maxDrawdownPct}.`}>
            {(id) => <NumberField id={id} value={risk.maxDrawdownPct} min={0.1} max={TRADING_HARD_CEILING.maxDrawdownPct} step={0.1} suffix="%" onChange={(n) => setRisk("maxDrawdownPct", n)} />}
          </Field>
          <Field label="Skip an order if the price moved more than" hint={`Percent. Protects against an old or wrong price. Highest allowed: ${TRADING_HARD_CEILING.priceBandPct}.`}>
            {(id) => <NumberField id={id} value={risk.priceBandPct} min={0.1} max={TRADING_HARD_CEILING.priceBandPct} step={0.1} suffix="%" onChange={(n) => setRisk("priceBandPct", n)} />}
          </Field>
          <Field label="Fee it assumes on every trade" hint="Percent per buy or sell. Up to 2.">
            {(id) => <NumberField id={id} value={risk.feeRatePct} min={0} max={2} step={0.05} suffix="%" onChange={(n) => setRisk("feeRatePct", n)} />}
          </Field>
          <div className="space-y-2">
            <Field label="Ask you first" hint="A buy that needs your OK shows up as a card before it counts.">
              {(id) => (
                <PickField
                  id={id}
                  value={risk.approvalAboveNok === null ? "every" : "above"}
                  options={[
                    { value: "every", label: "Before every buy" },
                    { value: "above", label: "Only before bigger buys" },
                  ]}
                  onChange={(kind) => setRisk("approvalAboveNok", kind === "every" ? null : (DEFAULT_TRADING_RISK_CONFIG.approvalAboveNok ?? 500))}
                />
              )}
            </Field>
            {risk.approvalAboveNok !== null ? (
              <Field label="Bigger means at least">
                {(id) => <NumberField id={id} value={risk.approvalAboveNok!} min={1} suffix="NOK" onChange={(n) => setRisk("approvalAboveNok", n)} />}
              </Field>
            ) : null}
          </div>
        </div>
      </Section>

      <Section title="How much" intro="How big each buy is.">
        <Field label="Size each buy by">
          {(id) => (
            <PickField
              id={id}
              value={spec.sizing.kind}
              options={[
                { value: "fraction_of_cash", label: "A share of the play money" },
                { value: "risk_per_trade", label: "What it is willing to lose" },
              ]}
              onChange={(kind) => change((d) => void (d.sizing = kind === "fraction_of_cash" ? { kind, fraction: 0.1 } : { kind, riskPerTradePct: 1 }))}
            />
          )}
        </Field>
        {spec.sizing.kind === "fraction_of_cash" ? (
          <Field label="Share of the play money in each buy" hint="Between 1 and 100 percent.">
            {(id) => (
              <NumberField
                id={id}
                value={Math.round(spec.sizing.kind === "fraction_of_cash" ? spec.sizing.fraction * 1000 : 0) / 10}
                min={0.1}
                max={100}
                step={0.1}
                suffix="%"
                onChange={(pct) => change((d) => void (d.sizing = { kind: "fraction_of_cash", fraction: Math.round(pct * 10) / 1000 }))}
              />
            )}
          </Field>
        ) : (
          <Field label="Most to lose if the safety stop is hit" hint="Percent of the play money, up to 5. Needs a safety stop.">
            {(id) => <NumberField id={id} value={spec.sizing.kind === "risk_per_trade" ? spec.sizing.riskPerTradePct : 1} min={0.1} max={5} step={0.1} suffix="%" onChange={(riskPerTradePct) => change((d) => void (d.sizing = { kind: "risk_per_trade", riskPerTradePct }))} />}
          </Field>
        )}
      </Section>

      <Section title="What it predicts" intro="Every buy comes with a prediction that is scored later, so you can see how often the strategy is right.">
        <Field label="Kind of prediction">
          {(id) => (
            <PickField
              id={id}
              value={spec.prediction.kind}
              options={[
                { value: "direction", label: "Will the price be higher or lower?" },
                { value: "target_before_stop", label: "Will the profit goal come before the safety stop?" },
              ]}
              onChange={(kind) => change((d) => void (d.prediction.kind = kind))}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Checked after" hint="Counted in candles. Between 1 and 200.">
            {(id) => <NumberField id={id} value={spec.prediction.horizonBars} min={1} max={200} suffix="candles" onChange={(n) => change((d) => void (d.prediction.horizonBars = n))} />}
          </Field>
          {spec.prediction.kind === "direction" ? (
            <Field label="Counts as flat if it moved less than" hint="Percent. A tiny move either way is neither up nor down. Up to 5.">
              {(id) => <NumberField id={id} value={spec.prediction.flatBandPct} min={0} max={5} step={0.05} suffix="%" onChange={(n) => change((d) => void (d.prediction.flatBandPct = n))} />}
            </Field>
          ) : null}
        </div>
        <Field label="Gains and losses are measured in" hint="Used when the scoreboard compares trades of different sizes.">
          {(id) => (
            <PickField
              id={id}
              value={spec.prediction.rUnit}
              options={[
                { value: "stop_distance", label: "Distances to the safety stop" },
                { value: "atr_at_entry", label: "Average candle sizes when it bought" },
              ]}
              onChange={(rUnit) => change((d) => void (d.prediction.rUnit = rUnit))}
            />
          )}
        </Field>
      </Section>

      <Section title="Your guidelines" intro="Anything you want the analyst to keep in mind.">
        <Field label={GUIDELINES_LABEL} hint={`${guidelines.length.toLocaleString("nb-NO")} of ${TRADING_GUIDELINES_MAX.toLocaleString("nb-NO")} characters.`}>
          {(id) => <Textarea id={id} rows={5} maxLength={TRADING_GUIDELINES_MAX} value={guidelines} onChange={(e) => onGuidelinesChange(e.target.value)} placeholder="For example: I would rather miss a trade than buy into a sudden spike." />}
        </Field>
      </Section>
    </div>
  );
}

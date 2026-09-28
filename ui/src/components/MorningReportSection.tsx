import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Label } from "@/components/ui/label";

/**
 * MorningReportSettings is the JSONB value stored in agents.morning_report_settings.
 * The Backend Engineer adds the column in migration 0183.
 * Source identifiers match the backend RSS/search source list.
 */
export type MorningReportSettings = {
  enabled: boolean;
  time: string;              // "HH:MM" 24-hour clock
  timezone: string;          // IANA e.g. "Europe/Oslo"
  placeOverride: string | null;
  placeOverrideUntil: string | null;  // ISO date "YYYY-MM-DD"
  sources: string[];
  topics: string[];
  hobbyTopics: string[];
  sportFollows: string[];
  priceSymbols: string[];
  maxHeadlines: number;
};

export const DEFAULT_MORNING_REPORT_SETTINGS: MorningReportSettings = {
  enabled: false,
  time: "07:00",
  timezone: "Europe/Oslo",
  placeOverride: null,
  placeOverrideUntil: null,
  sources: ["nettavisen", "dagbladet", "bbc", "aljazeera", "pcmag", "financial_times", "android_central", "gizmodo", "zelda_dungeon", "techradar", "99bitcoins"],
  topics: ["crypto", "ai", "tech", "geopolitics"],
  hobbyTopics: ["zelda", "pokemon", "one_piece", "vikings", "medieval", "lego_adults"],
  sportFollows: ["mats_zuccarello_nhl"],
  priceSymbols: ["BTC", "SOL", "ETH", "DNB.OL"],
  maxHeadlines: 10,
};

const NEWS_SOURCES = [
  { id: "nettavisen", label: "Nettavisen" },
  { id: "dagbladet", label: "Dagbladet" },
  { id: "bbc", label: "BBC" },
  { id: "aljazeera", label: "Al Jazeera" },
  { id: "pcmag", label: "PCMag" },
  { id: "financial_times", label: "Financial Times" },
  { id: "android_central", label: "Android Central" },
  { id: "gizmodo", label: "Gizmodo" },
  { id: "zelda_dungeon", label: "Zelda Dungeon" },
  { id: "techradar", label: "TechRadar" },
  { id: "99bitcoins", label: "99Bitcoins" },
];

const NEWS_TOPICS = [
  { id: "crypto", label: "Crypto" },
  { id: "ai", label: "AI" },
  { id: "tech", label: "Tech" },
  { id: "geopolitics", label: "Geopolitics (markets)" },
];

const HOBBY_TOPICS = [
  { id: "zelda", label: "Zelda" },
  { id: "pokemon", label: "Pokémon" },
  { id: "one_piece", label: "One Piece" },
  { id: "vikings", label: "Vikings" },
  { id: "medieval", label: "Medieval themes" },
  { id: "lego_adults", label: "Lego (adults 18+)" },
];

const PRICE_SYMBOLS = [
  { id: "BTC", label: "Bitcoin (BTC)" },
  { id: "SOL", label: "Solana (SOL)" },
  { id: "ETH", label: "Ethereum (ETH)" },
  { id: "DNB.OL", label: "DNB Bank (Oslo Børs)" },
];

const SPORT_FOLLOWS = [
  { id: "mats_zuccarello_nhl", label: "Mats Zuccarello (NHL)" },
];

function parseMorningReportSettings(raw: unknown): MorningReportSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_MORNING_REPORT_SETTINGS;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : false,
    time: typeof r.time === "string" ? r.time : "07:00",
    timezone: typeof r.timezone === "string" ? r.timezone : "Europe/Oslo",
    placeOverride: typeof r.placeOverride === "string" ? r.placeOverride : null,
    placeOverrideUntil: typeof r.placeOverrideUntil === "string" ? r.placeOverrideUntil : null,
    sources: Array.isArray(r.sources) ? (r.sources as string[]) : DEFAULT_MORNING_REPORT_SETTINGS.sources,
    topics: Array.isArray(r.topics) ? (r.topics as string[]) : DEFAULT_MORNING_REPORT_SETTINGS.topics,
    hobbyTopics: Array.isArray(r.hobbyTopics) ? (r.hobbyTopics as string[]) : DEFAULT_MORNING_REPORT_SETTINGS.hobbyTopics,
    sportFollows: Array.isArray(r.sportFollows) ? (r.sportFollows as string[]) : DEFAULT_MORNING_REPORT_SETTINGS.sportFollows,
    priceSymbols: Array.isArray(r.priceSymbols) ? (r.priceSymbols as string[]) : DEFAULT_MORNING_REPORT_SETTINGS.priceSymbols,
    maxHeadlines: typeof r.maxHeadlines === "number" ? r.maxHeadlines : 10,
  };
}

function CheckboxGroup({
  items,
  selected,
  onChange,
  disabled,
}: {
  items: { id: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  function toggle(id: string, checked: boolean) {
    const next = checked ? [...selected, id] : selected.filter((s) => s !== id);
    onChange(next);
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      {items.map((item) => (
        <label key={item.id} className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={selected.includes(item.id)}
            onCheckedChange={(v) => toggle(item.id, v === true)}
            disabled={disabled}
          />
          <span className="text-sm">{item.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * Morning report settings for a quick agent. Shown on the agent's settings
 * tab when the quick-agent switch is on. All fields are board-only; the
 * server refuses writes from agents (same guard as laneAEnabled and friends).
 *
 * The backend column (agents.morning_report_settings JSONB) is added in
 * migration 0183 by the Backend Engineer. Until that ships, this card is
 * rendered but the field will come back as undefined from the API, which the
 * parser handles by returning defaults.
 */
export function MorningReportSection({
  agent,
  companyId,
}: {
  agent: {
    id: string;
    urlKey: string;
    companyId: string;
    morningReportSettings?: unknown;
  };
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const saved = parseMorningReportSettings(agent.morningReportSettings);
  const [draft, setDraft] = useState<MorningReportSettings | null>(null);
  const settings = draft ?? saved;
  const dirty = draft !== null;

  function update(patch: Partial<MorningReportSettings>) {
    setDraft({ ...(draft ?? saved), ...patch });
  }

  function toggleCheckbox(
    field: "sources" | "topics" | "hobbyTopics" | "sportFollows" | "priceSymbols",
    id: string,
    checked: boolean,
  ) {
    const current = settings[field] as string[];
    const next = checked ? [...current, id] : current.filter((v) => v !== id);
    update({ [field]: next });
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
  };

  const saveMutation = useMutation({
    mutationFn: (next: MorningReportSettings) =>
      agentsApi.update(agent.id, { morningReportSettings: next }, companyId),
    onSuccess: () => {
      invalidate();
      setDraft(null);
      pushToast({ title: "Morning report settings saved", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Could not save morning report settings", tone: "error" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      agentsApi.update(agent.id, { morningReportSettings: { ...saved, enabled } }, companyId),
    onSuccess: () => {
      invalidate();
      setDraft(null);
    },
    onError: () => {
      pushToast({ title: "Could not update morning report", tone: "error" });
    },
  });

  const saving = saveMutation.isPending || toggleMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Morning report</CardTitle>
            <CardDescription>
              Send a daily briefing to this agent's Telegram chat at a set time each morning.
            </CardDescription>
          </div>
          <ToggleSwitch
            checked={settings.enabled}
            onCheckedChange={(v) => toggleMutation.mutate(v)}
            disabled={saving}
            aria-label="Enable morning report"
          />
        </div>
      </CardHeader>

      {settings.enabled && (
        <CardContent className="space-y-6">
          {/* Delivery time */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="mr-time">Send at</Label>
              <Input
                id="mr-time"
                type="time"
                value={settings.time}
                onChange={(e) => update({ time: e.target.value })}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-timezone">Time zone</Label>
              <Input
                id="mr-timezone"
                value={settings.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
                placeholder="Europe/Oslo"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">IANA name, e.g. Europe/Oslo, America/New_York</p>
            </div>
          </div>

          {/* Place override */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="mr-place">Location for weather</Label>
              <Input
                id="mr-place"
                value={settings.placeOverride ?? ""}
                onChange={(e) => update({ placeOverride: e.target.value || null })}
                placeholder="Drøbak"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">Leave empty to use the default from instructions</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mr-place-until">Use this location until</Label>
              <Input
                id="mr-place-until"
                type="date"
                value={settings.placeOverrideUntil ?? ""}
                onChange={(e) => update({ placeOverrideUntil: e.target.value || null })}
                disabled={saving || !settings.placeOverride}
              />
              <p className="text-xs text-muted-foreground">After this date the override is ignored</p>
            </div>
          </div>

          {/* Headlines */}
          <div className="space-y-1.5">
            <Label htmlFor="mr-max-headlines">Max headlines per day</Label>
            <Input
              id="mr-max-headlines"
              type="number"
              min={1}
              max={10}
              value={settings.maxHeadlines}
              onChange={(e) => update({ maxHeadlines: Math.min(10, Math.max(1, Number(e.target.value))) })}
              disabled={saving}
              className="w-24"
            />
          </div>

          {/* News sources */}
          <div className="space-y-2">
            <Label>News sources</Label>
            <p className="text-xs text-muted-foreground">
              Headlines are pulled from RSS feeds where available, search otherwise. Tick the sources to include.
            </p>
            <CheckboxGroup
              items={NEWS_SOURCES}
              selected={settings.sources}
              onChange={(v) => update({ sources: v })}
              disabled={saving}
            />
          </div>

          {/* Topics */}
          <div className="space-y-2">
            <Label>Topics for news</Label>
            <p className="text-xs text-muted-foreground">
              Headlines are filtered to these topics. Untick to skip that category.
            </p>
            <CheckboxGroup
              items={NEWS_TOPICS}
              selected={settings.topics}
              onChange={(v) => update({ topics: v })}
              disabled={saving}
            />
          </div>

          {/* Hobby topics */}
          <div className="space-y-2">
            <Label>Hobby news</Label>
            <p className="text-xs text-muted-foreground">
              New releases only — no rumours or speculation.
            </p>
            <CheckboxGroup
              items={HOBBY_TOPICS}
              selected={settings.hobbyTopics}
              onChange={(v) => update({ hobbyTopics: v })}
              disabled={saving}
            />
          </div>

          {/* Sport */}
          <div className="space-y-2">
            <Label>Sport</Label>
            <CheckboxGroup
              items={SPORT_FOLLOWS}
              selected={settings.sportFollows}
              onChange={(v) => update({ sportFollows: v })}
              disabled={saving}
            />
          </div>

          {/* Prices */}
          <div className="space-y-2">
            <Label>Prices</Label>
            <p className="text-xs text-muted-foreground">
              Shows each price with the change since yesterday. Uses the price watchers service.
            </p>
            <CheckboxGroup
              items={PRICE_SYMBOLS}
              selected={settings.priceSymbols}
              onChange={(v) => update({ priceSymbols: v })}
              disabled={saving}
            />
          </div>

          {/* Save */}
          {dirty && (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => saveMutation.mutate(settings)}
                disabled={saving}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft(null)}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

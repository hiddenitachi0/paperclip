import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { morningReportsApi } from "../api/morning-reports";
import { pluginsApi } from "../api/plugins";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MorningReportOutboxItem } from "@paperclipai/shared";

/**
 * DUR-4138: picture source choice for one report picture (weather or mood) —
 * mirrors packages/shared/src/morning-report.ts's
 * `MorningReportPictureSource`/`MORNING_REPORT_PICTURE_PROVIDERS` by hand (ui
 * does not depend on the media-studio plugin package, so this stays a local
 * copy, same as the rest of this file's settings shape).
 */
export type MorningReportPictureSource =
  | { kind: "default" }
  | { kind: "look"; lookId: string }
  | { kind: "model"; provider: "sogni" | "fal"; model: string };

export const DEFAULT_MORNING_REPORT_PICTURE_SOURCE: MorningReportPictureSource = { kind: "default" };

function parsePictureSource(value: unknown): MorningReportPictureSource {
  if (!value || typeof value !== "object") return DEFAULT_MORNING_REPORT_PICTURE_SOURCE;
  const v = value as Record<string, unknown>;
  if (v.kind === "look" && typeof v.lookId === "string" && v.lookId.trim()) {
    return { kind: "look", lookId: v.lookId };
  }
  if (v.kind === "model" && (v.provider === "sogni" || v.provider === "fal") && typeof v.model === "string" && v.model.trim()) {
    return { kind: "model", provider: v.provider, model: v.model };
  }
  return DEFAULT_MORNING_REPORT_PICTURE_SOURCE;
}

/**
 * DUR-4138: the media-studio plugin's own id/action key, hardcoded here the
 * same way `plugin_tool_grants` names are hardcoded elsewhere (e.g.
 * "paperclip.media-studio:generate-image" in ui/src/api/plugins.ts) — the ui
 * package has no build dependency on packages/plugins/media-studio, so these
 * cannot be imported; keep in sync by hand with
 * packages/plugins/media-studio/src/manifest.ts's PLUGIN_ID/ACTION_LOOKS_LIST.
 */
const MEDIA_STUDIO_PLUGIN_ID = "paperclip.media-studio";
const MEDIA_STUDIO_ACTION_LOOKS_LIST = "looks.list";

interface MediaStudioLookOption {
  id: string;
  name: string;
}

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
  /** DUR-4138: which look/model to use for the weather picture; absent (older saved settings) reads as "the agent's own default look". */
  weatherPicture: MorningReportPictureSource;
  /** DUR-4138: same as weatherPicture, for the mood picture. */
  moodPicture: MorningReportPictureSource;
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
  weatherPicture: DEFAULT_MORNING_REPORT_PICTURE_SOURCE,
  moodPicture: DEFAULT_MORNING_REPORT_PICTURE_SOURCE,
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
    weatherPicture: parsePictureSource(r.weatherPicture),
    moodPicture: parsePictureSource(r.moodPicture),
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
 * DUR-4138: one picture's look/model choice — "use my default look" (the
 * agent's own default, same as before this setting existed), a saved Media
 * Studio look (by id), or a picture model picked directly (provider + a
 * free-text model name: Media Studio has no model-listing endpoint for the
 * ui to call here, and Sogni's own model catalog changes over time, so a
 * plain text field is the same tradeoff the looks page itself makes when
 * Sogni's live model list cannot be fetched).
 */
function PictureSourcePicker({
  value,
  onChange,
  looks,
  looksLoading,
  disabled,
}: {
  value: MorningReportPictureSource;
  onChange: (next: MorningReportPictureSource) => void;
  looks: MediaStudioLookOption[];
  looksLoading: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === "look") onChange({ kind: "look", lookId: looks[0]?.id ?? "" });
          else if (kind === "model") onChange({ kind: "model", provider: "sogni", model: "" });
          else onChange({ kind: "default" });
        }}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Use my default look</SelectItem>
          <SelectItem value="look">A saved look</SelectItem>
          <SelectItem value="model">A specific model</SelectItem>
        </SelectContent>
      </Select>

      {value.kind === "look" && (
        <Select
          value={value.lookId}
          onValueChange={(lookId) => onChange({ kind: "look", lookId })}
          disabled={disabled || looksLoading}
        >
          <SelectTrigger size="sm" className="w-56">
            <SelectValue placeholder={looksLoading ? "Loading looks…" : "Choose a saved look"} />
          </SelectTrigger>
          <SelectContent>
            {looks.map((look) => (
              <SelectItem key={look.id} value={look.id}>
                {look.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.kind === "model" && (
        <div className="flex gap-2">
          <Select
            value={value.provider}
            onValueChange={(provider) => onChange({ kind: "model", provider: provider as "sogni" | "fal", model: value.model })}
            disabled={disabled}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sogni">Sogni</SelectItem>
              <SelectItem value="fal">Fal.ai</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={value.model}
            onChange={(e) => onChange({ kind: "model", provider: value.provider, model: e.target.value })}
            placeholder="Model name"
            disabled={disabled}
            className="w-40"
          />
        </div>
      )}
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

  // DUR-4138: saved Media Studio looks, for the weather/mood picture pickers
  // below — fetched only once the card is open (settings.enabled), via the
  // same host-callable action proxy the looks page itself uses.
  const looksQuery = useQuery({
    queryKey: ["morning-report-looks", agent.companyId],
    queryFn: async () => {
      const response = await pluginsApi.bridgePerformAction(
        MEDIA_STUDIO_PLUGIN_ID,
        MEDIA_STUDIO_ACTION_LOOKS_LIST,
        {},
        agent.companyId,
      );
      const data = response.data as { looks?: MediaStudioLookOption[] } | undefined;
      return Array.isArray(data?.looks) ? data.looks : [];
    },
    enabled: settings.enabled,
    staleTime: 60_000,
  });
  const looks = looksQuery.data ?? [];

  const [testResult, setTestResult] = useState<MorningReportOutboxItem | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const testMutation = useMutation({
    mutationFn: () => morningReportsApi.sendTestNow(agent.companyId, agent.id),
    onMutate: () => {
      setTestResult(null);
      setTestError(null);
    },
    onSuccess: (result) => setTestResult(result),
    onError: (err) => {
      setTestError(
        err instanceof ApiError
          ? err.message
          : "Could not send a test report right now. Try again in a moment.",
      );
    },
  });

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
          {/* Send a test report now (DUR-4075): try changes without waiting for the scheduled time */}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? "Sending test report…" : "Send a test report now"}
              </Button>
              <Button size="sm" variant="ghost" asChild>
                <Link to={`/agents/${agent.id}/morning-reports`}>Past reports</Link>
              </Button>
            </div>
            {testResult && (
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm space-y-1.5">
                <p className="text-muted-foreground">Test report sent. Here is what it says:</p>
                <p className="whitespace-pre-line">{testResult.text}</p>
                <Link
                  to={`/agents/${agent.id}/morning-reports/${testResult.id}`}
                  className="text-primary hover:underline inline-block"
                >
                  Open the full briefing page
                </Link>
              </div>
            )}
            {testError && (
              <p className="text-sm text-destructive">{testError}</p>
            )}
          </div>

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

          {/* DUR-4138: per-picture look/model choice */}
          <div className="space-y-2">
            <Label>Weather picture</Label>
            <PictureSourcePicker
              value={settings.weatherPicture}
              onChange={(v) => update({ weatherPicture: v })}
              looks={looks}
              looksLoading={looksQuery.isLoading}
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <Label>Mood picture</Label>
            <PictureSourcePicker
              value={settings.moodPicture}
              onChange={(v) => update({ moodPicture: v })}
              looks={looks}
              looksLoading={looksQuery.isLoading}
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

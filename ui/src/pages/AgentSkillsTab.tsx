import { useEffect, useMemo, useState, useRef, type MouseEvent } from "react";
import { Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { queryKeys } from "../lib/queryKeys";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import { adapterLabels } from "../components/agent-config-primitives";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";
import { type Agent, type AgentSkillEntry } from "@paperclipai/shared";
import { applyAgentSkillSnapshot, arraysEqual, isReadOnlyUnmanagedSkillEntry } from "../lib/agent-skills-state";
import {
  firstSentence,
  groupSkills,
  matchesSkillSearch,
  skillGroupFor,
  sortSelectedFirst,
  stripInlineMarkdown,
} from "../lib/skill-groups";
import { SettingsSection, SettingsSubsection } from "../components/SettingsSection";

/** Above this many skills the list gets a search box. */
const SKILL_SEARCH_THRESHOLD = 12;

/**
 * A skill's description cut to its first sentence, with a "More" toggle that
 * shows the whole text. The toggle sits inside the row's <label>, so its click
 * must not tick or untick the skill.
 */
function SkillSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const { first, hasMore } = useMemo(() => firstSentence(text), [text]);
  const toggle = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setExpanded((value) => !value);
  };
  const toggleButton = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={expanded}
      className="text-xs font-medium text-foreground/70 underline-offset-4 hover:text-foreground hover:underline"
      data-testid="skill-summary-toggle"
    >
      {expanded ? "Less" : "More"}
    </button>
  );

  if (!hasMore || expanded) {
    return (
      <div className="mt-1" data-testid="skill-summary">
        <MarkdownBody className="text-xs text-muted-foreground prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {text}
        </MarkdownBody>
        {hasMore ? <div className="mt-1">{toggleButton}</div> : null}
      </div>
    );
  }

  return (
    <p className="mt-1 text-xs text-muted-foreground" data-testid="skill-summary">
      {stripInlineMarkdown(first)} {toggleButton}
    </p>
  );
}

export function AgentSkillsTab({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId?: string;
}) {
  type SkillRow = {
    id: string;
    key: string;
    slug: string | null;
    name: string;
    description: string | null;
    categories: string[];
    detail: string | null;
    locationLabel: string | null;
    originLabel: string | null;
    linkTo: string | null;
    readOnly: boolean;
    adapterEntry: AgentSkillEntry | null;
  };

  const queryClient = useQueryClient();
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [lastSavedSkills, setLastSavedSkills] = useState<string[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const lastSavedSkillsRef = useRef<string[]>([]);
  const hasHydratedSkillSnapshotRef = useRef(false);
  const skipNextSkillAutosaveRef = useRef(true);

  const { data: skillSnapshot, isLoading } = useQuery({
    queryKey: queryKeys.agents.skills(agent.id),
    queryFn: () => agentsApi.skills(agent.id, companyId),
    enabled: Boolean(companyId),
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(companyId ?? ""),
    queryFn: () => companySkillsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const syncSkills = useMutation({
    mutationFn: (desiredSkills: string[]) => agentsApi.syncSkills(agent.id, desiredSkills, companyId),
    onSuccess: async (snapshot) => {
      queryClient.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
      lastSavedSkillsRef.current = snapshot.desiredSkills;
      setLastSavedSkills(snapshot.desiredSkills);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
      ]);
    },
  });

  useEffect(() => {
    setSkillDraft([]);
    setLastSavedSkills([]);
    lastSavedSkillsRef.current = [];
    hasHydratedSkillSnapshotRef.current = false;
    skipNextSkillAutosaveRef.current = true;
  }, [agent.id]);

  useEffect(() => {
    if (!skillSnapshot) return;
    const nextState = applyAgentSkillSnapshot(
      {
        draft: skillDraft,
        lastSaved: lastSavedSkillsRef.current,
        hasHydratedSnapshot: hasHydratedSkillSnapshotRef.current,
      },
      skillSnapshot.desiredSkills,
    );
    skipNextSkillAutosaveRef.current = nextState.shouldSkipAutosave;
    hasHydratedSkillSnapshotRef.current = nextState.hasHydratedSnapshot;
    setSkillDraft(nextState.draft);
    lastSavedSkillsRef.current = nextState.lastSaved;
    setLastSavedSkills(nextState.lastSaved);
  }, [skillDraft, skillSnapshot]);

  useEffect(() => {
    if (!skillSnapshot) return;
    if (skipNextSkillAutosaveRef.current) {
      skipNextSkillAutosaveRef.current = false;
      return;
    }
    if (syncSkills.isPending) return;
    if (arraysEqual(skillDraft, lastSavedSkillsRef.current)) return;

    const timeout = window.setTimeout(() => {
      if (!arraysEqual(skillDraft, lastSavedSkillsRef.current)) {
        syncSkills.mutate(skillDraft);
      }
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [skillDraft, skillSnapshot, syncSkills.isPending, syncSkills.mutate]);

  const companySkillByKey = useMemo(
    () => new Map((companySkills ?? []).map((skill) => [skill.key, skill])),
    [companySkills],
  );
  const companySkillKeys = useMemo(
    () => new Set((companySkills ?? []).map((skill) => skill.key)),
    [companySkills],
  );
  const adapterEntryByKey = useMemo(
    () => new Map((skillSnapshot?.entries ?? []).map((entry) => [entry.key, entry])),
    [skillSnapshot],
  );
  const optionalSkillRows = useMemo<SkillRow[]>(
    () =>
      (companySkills ?? []).map((skill) => ({
        id: skill.id,
        key: skill.key,
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        categories: skill.categories ?? [],
        detail: adapterEntryByKey.get(skill.key)?.detail ?? null,
        locationLabel: adapterEntryByKey.get(skill.key)?.locationLabel ?? null,
        originLabel: adapterEntryByKey.get(skill.key)?.originLabel ?? null,
        linkTo: `/skills/${skill.id}`,
        readOnly: false,
        adapterEntry: adapterEntryByKey.get(skill.key) ?? null,
      })),
    [adapterEntryByKey, companySkills],
  );
  const unmanagedSkillRows = useMemo<SkillRow[]>(
    () =>
      (skillSnapshot?.entries ?? [])
        .filter((entry) => isReadOnlyUnmanagedSkillEntry(entry, companySkillKeys))
        .map((entry) => ({
          id: `external:${entry.key}`,
          key: entry.key,
          slug: null,
          name: entry.runtimeName ?? entry.key,
          description: null,
          categories: [],
          detail: entry.detail ?? null,
          locationLabel: entry.locationLabel ?? null,
          originLabel: entry.originLabel ?? null,
          linkTo: null,
          readOnly: true,
          adapterEntry: entry,
        })),
    [companySkillKeys, skillSnapshot],
  );
  const draftSkillKeys = useMemo(() => new Set(skillDraft), [skillDraft]);
  const selectedCompanySkillCount = useMemo(
    () => optionalSkillRows.filter((skill) => draftSkillKeys.has(skill.key)).length,
    [draftSkillKeys, optionalSkillRows],
  );
  // Names of the skills that are on, for the one-line "On for this agent" list.
  // A requested skill missing from the library is shown by its key.
  const selectedSkillNames = useMemo(
    () =>
      skillDraft
        .map((key) => companySkillByKey.get(key)?.name ?? key)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    [companySkillByKey, skillDraft],
  );
  const skillGroups = useMemo(
    () => groupSkills(optionalSkillRows, (skill) => draftSkillKeys.has(skill.key)),
    [draftSkillKeys, optionalSkillRows],
  );
  // Groups start open when they hold a skill that was already on when the page
  // loaded; the rest start closed and say "0 of 3 on". Read from the saved
  // snapshot (not the draft) so the first render already knows the answer.
  const initiallyOnSkillKeys = useMemo(
    () => new Set(skillSnapshot?.desiredSkills ?? []),
    [skillSnapshot?.desiredSkills],
  );
  const showSkillSearch = optionalSkillRows.length > SKILL_SEARCH_THRESHOLD;
  const activeSkillQuery = showSkillSearch ? skillQuery.trim() : "";
  const skillSearchResults = useMemo(
    () =>
      activeSkillQuery
        ? sortSelectedFirst(
            optionalSkillRows.filter((skill) => matchesSkillSearch(skill, activeSkillQuery)),
            (skill) => draftSkillKeys.has(skill.key),
          )
        : [],
    [activeSkillQuery, draftSkillKeys, optionalSkillRows],
  );
  const desiredOnlyMissingSkills = useMemo(
    () => skillDraft.filter((key) => !companySkillByKey.has(key)),
    [companySkillByKey, skillDraft],
  );
  const skillApplicationLabel = useMemo(() => {
    switch (skillSnapshot?.mode) {
      case "persistent":
        return "Kept in the workspace";
      case "ephemeral":
        return "Applied when the agent runs";
      case "unsupported":
        return "Tracked only";
      default:
        return "Unknown";
    }
  }, [skillSnapshot?.mode]);
  const unsupportedSkillMessage = useMemo(() => {
    if (skillSnapshot?.mode !== "unsupported") return null;
    if (
      agent.adapterType === "acpx_local" &&
      typeof agent.adapterConfig.agent === "string" &&
      agent.adapterConfig.agent === "custom"
    ) {
      return "Paperclip cannot manage skills for custom ACP commands yet.";
    }
    if (agent.adapterType === "openclaw_gateway") {
      return "Paperclip cannot manage OpenClaw skills here. Visit your OpenClaw instance to manage this agent's skills.";
    }
    return "Paperclip cannot manage skills for this adapter yet. Manage them in the adapter directly.";
  }, [agent.adapterConfig.agent, agent.adapterType, skillSnapshot?.mode]);
  const hasUnsavedChanges = !arraysEqual(skillDraft, lastSavedSkills);
  const saveStatusLabel = syncSkills.isPending
    ? "Saving changes..."
    : hasUnsavedChanges
      ? "Saving soon..."
      : null;

  const renderSkillRow = (skill: SkillRow, groupLabel?: string) => {
    const summaryText = resolveSkillSummaryText(skill, { fallbackKey: true });
    const rowClassName = cn(
      "flex items-start gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0",
      skill.readOnly ? "bg-muted/20" : "hover:bg-accent/20",
    );
    const body = (
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium" data-testid="agent-skill-name">{skill.name}</span>
            {groupLabel ? <span className="shrink-0 text-xs text-muted-foreground">{groupLabel}</span> : null}
          </div>
          {skill.linkTo ? (
            <Link
              to={skill.linkTo}
              className="shrink-0 text-xs text-muted-foreground no-underline hover:text-foreground"
            >
              View
            </Link>
          ) : null}
        </div>
        {summaryText && <SkillSummary text={summaryText} />}
        {skill.readOnly && skill.originLabel && (
          <p className="mt-1 text-xs text-muted-foreground">{skill.originLabel}</p>
        )}
        {skill.readOnly && skill.locationLabel && (
          <p className="mt-1 text-xs text-muted-foreground">Location: {skill.locationLabel}</p>
        )}
        {skill.detail && (
          <p className="mt-1 text-xs text-muted-foreground">{skill.detail}</p>
        )}
      </div>
    );

    if (skill.readOnly) {
      return (
        <div key={skill.id} className={rowClassName}>
          <span className="mt-1 h-2 w-2 rounded-full bg-muted-foreground/40" />
          {body}
        </div>
      );
    }

    const checked = skillDraft.includes(skill.key);
    const disabled = skillSnapshot?.mode === "unsupported";
    const checkbox = (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={skill.name}
        onChange={(event) => {
          const next = event.target.checked
            ? Array.from(new Set([...skillDraft, skill.key]))
            : skillDraft.filter((value) => value !== skill.key);
          setSkillDraft(next);
        }}
        className="mt-0.5 disabled:cursor-not-allowed disabled:opacity-60"
      />
    );

    return (
      <label key={skill.id} className={rowClassName} data-testid={`agent-skill-row-${skill.key}`}>
        {skillSnapshot?.mode === "unsupported" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{checkbox}</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {unsupportedSkillMessage ?? "Manage skills in the adapter directly."}
            </TooltipContent>
          </Tooltip>
        ) : (
          checkbox
        )}
        {body}
      </label>
    );
  };

  const renderSkillList = (rows: SkillRow[], groupLabelFor?: (skill: SkillRow) => string) => (
    <div className="overflow-hidden rounded-md border border-border">
      {rows.map((skill) => renderSkillRow(skill, groupLabelFor?.(skill)))}
    </div>
  );

  const hasAnySkills = optionalSkillRows.length > 0 || unmanagedSkillRows.length > 0;
  const adapterLabel = adapterLabels[agent.adapterType] ?? agent.adapterType;

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/skills"
          className="text-sm font-medium text-foreground underline-offset-4 no-underline transition-colors hover:text-foreground/70 hover:underline"
        >
          View company skills library
        </Link>
        {saveStatusLabel ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {syncSkills.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>{saveStatusLabel}</span>
          </div>
        ) : null}
      </div>

      {syncSkills.isError && (
        <p className="text-xs text-destructive">
          {syncSkills.error instanceof Error ? syncSkills.error.message : "Failed to update skills"}
        </p>
      )}

      {skillSnapshot?.warnings.length ? (
        <div className="space-y-1 rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
          {skillSnapshot.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {unsupportedSkillMessage ? (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground">
          {unsupportedSkillMessage}
        </div>
      ) : null}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : (
        <>
          {!hasAnySkills ? (
            <section className="border-y border-border">
              <div className="px-3 py-6 text-sm text-muted-foreground">
                Import skills into the company library first, then attach them here.
              </div>
            </section>
          ) : null}

          {optionalSkillRows.length > 0 || skillDraft.length > 0 ? (
            <p className="text-sm" data-testid="agent-skills-on">
              <span className="font-medium">On for this agent:</span>{" "}
              <span className="text-muted-foreground">
                {selectedSkillNames.length > 0
                  ? selectedSkillNames.join(", ")
                  : skillSnapshot?.mode === "unsupported"
                    ? "none."
                    : "none yet. Tick a skill below to turn it on."}
              </span>
            </p>
          ) : null}

          {optionalSkillRows.length > 0 ? (
            <SettingsSection
              title="Skills by type"
              description="Tick a skill to turn it on for this agent. Changes save by themselves."
              summary={`${selectedCompanySkillCount} of ${optionalSkillRows.length} on`}
              storageKey="agent.skills.byType"
              data-testid="agent-skills-by-type"
            >
              {showSkillSearch ? (
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    value={skillQuery}
                    onChange={(event) => setSkillQuery(event.target.value)}
                    placeholder="Find a skill by name or description"
                    aria-label="Find a skill"
                    className="h-8 pl-8 text-sm"
                    data-testid="agent-skills-search"
                  />
                </div>
              ) : null}

              {activeSkillQuery ? (
                <div data-testid="agent-skills-search-results">
                  {skillSearchResults.length > 0 ? (
                    renderSkillList(skillSearchResults, (skill) => skillGroupFor(skill).label)
                  ) : (
                    <p className="text-sm text-muted-foreground">No skills match "{activeSkillQuery}".</p>
                  )}
                </div>
              ) : (
                skillGroups.map(({ group, skills, selectedCount }) => (
                  <SettingsSubsection
                    key={group.id}
                    title={group.label}
                    summary={`${selectedCount} of ${skills.length} on`}
                    defaultOpen={skills.some((skill) => initiallyOnSkillKeys.has(skill.key))}
                    storageKey={`agent.skills.group.${group.id}`}
                    data-testid={`agent-skill-group-${group.id}`}
                  >
                    {renderSkillList(skills)}
                  </SettingsSubsection>
                ))
              )}
            </SettingsSection>
          ) : null}

          {desiredOnlyMissingSkills.length > 0 && (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="font-medium">Requested skills missing from the company library</div>
              <div className="mt-1 text-xs">
                {desiredOnlyMissingSkills.join(", ")}
              </div>
            </div>
          )}

          <SettingsSection
            title="More about skills"
            storageKey="agent.skills.details"
            data-testid="agent-skills-details"
          >
            {unmanagedSkillRows.length > 0 ? (
              <SettingsSubsection
                title={`Added outside Paperclip (${unmanagedSkillRows.length})`}
                description="These were installed straight into the agent's own tools. Paperclip shows them but cannot turn them on or off."
                summary="Read only"
                defaultOpen={false}
                storageKey="agent.skills.outside"
                data-testid="agent-skills-unmanaged"
              >
                {renderSkillList(unmanagedSkillRows)}
              </SettingsSubsection>
            ) : null}

            <SettingsSubsection
              title="How skills are applied"
              summary={`${adapterLabel} · ${skillApplicationLabel}`}
              defaultOpen={false}
              storageKey="agent.skills.howApplied"
              data-testid="agent-skills-how-applied"
            >
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Adapter</span>
                  <span className="font-medium">{adapterLabel}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Skills applied</span>
                  <span>{skillApplicationLabel}</span>
                </div>
                <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2">
                  <span className="text-muted-foreground">Selected skills</span>
                  <span>{skillDraft.length}</span>
                </div>
              </div>
            </SettingsSubsection>
          </SettingsSection>
        </>
      )}
    </div>
  );
}

/* ---- Tools Tab ---- */

// DUR-143: the checkbox side of the tool library — tick a tool on, it's
// merged into this agent's mcpServers at every dispatch (with its credential
// resolved from the secret it was created with); untick to revoke. No JSON,
// no server name to remember — just the tools this agent has, in words.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modelReadiness, type CreateModelDirectoryEntry, type ModelDirectoryEntry, type UpdateModelDirectoryEntry } from "@paperclipai/shared";
import { AlertCircle, Cpu, Download, Plus, Search } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { modelDirectoryApi } from "../api/modelDirectory";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  buildModelTree,
  CATALOGUE_GROUP_BY_OPTIONS,
  catalogueFileName,
  cloudProvidersInUse,
  compareEntriesBy,
  countsLine,
  criteriaInUse,
  defaultLocalAddress,
  filterEntries,
  findDuplicates,
  groupEntries,
  hasActiveFilters,
  isCatalogueGroupBy,
  resyncTargets,
  tagsInUse,
  whereLabel,
  type CatalogueGroupBy,
  type CatalogueSort,
  type CatalogueStatusFilter,
  type CatalogueUseFilter,
  type CatalogueWhereFilter,
} from "../lib/model-catalogue";
import { ModelEntryDialog } from "../components/ModelEntryDialog";
import { OpenRouterHostRules } from "../components/OpenRouterHostRules";
import { ModelCatalogueRow } from "../components/ModelCatalogueRow";
import { healthReading, setupFromEntry, useModelReadinessSources } from "../components/ModelReadiness";
import { ModelCatalogueImport } from "../components/ModelCatalogueImport";
import { ModelCatalogueTree } from "../components/ModelCatalogueTree";
import {
  GpuMemoryField,
  LocalAddressField,
  LocalSyncResults,
  NEEDS_ADDRESS_FOR_RESYNC,
  ResyncButton,
  useLocalResync,
  useModelDirectorySettings,
  type SyncOutcome,
} from "../components/ModelLocalSync";
import { HelpTip, MODEL_HELP } from "../components/ModelHelp";
import { SettingsSubsection } from "../components/SettingsSection";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Settings > Models: the company's catalogue of saved model setups. A setup
 * is a name plus the provider, model, address and defaults a quick agent
 * needs, so switching an agent's model is one pick instead of retyping five
 * fields. By default the page shows Maker > Model > Size > ways to run it,
 * adding the sizes and ways the built-in model list knows of (with "Add",
 * the `ollama pull` command, graphics-card fit and bigger "upgrade" sizes).
 * It filters, sorts by the company's own test scores, resyncs what the
 * company's model server has installed, and can export / import the whole
 * list as a file. Nothing assumes one particular computer: the graphics card
 * memory and the model server address are per-company settings at the top
 * (both "Not set" until someone enters them), and every field has help text.
 * No key is ever part of a setup; keys stay under Connections.
 *
 * Only the company owner and admins may change setups (the server enforces
 * it; this page just hides the buttons and says so in plain words when a
 * request is refused).
 */

export { bodyFromForm, providerLabel, providerUsesAddress } from "../components/ModelEntryDialog";

/** Plain-English text for any failed request on this page. */
export function modelErrorMessage(error: unknown, doing: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return `Only the company owner or an admin can ${doing}.`;
    if (error.status === 409) return "Another model setup already has that name. Pick a different name.";
    return error.message;
  }
  return `Could not ${doing}. Please try again.`;
}

const GROUP_BY_STORAGE_KEY = "paperclip.models.groupBy";

function readGroupBy(): CatalogueGroupBy {
  try {
    const stored = window.localStorage.getItem(GROUP_BY_STORAGE_KEY);
    if (isCatalogueGroupBy(stored)) return stored;
  } catch {
    // Storage blocked: use the default.
  }
  return "maker";
}

function writeGroupBy(value: CatalogueGroupBy) {
  try {
    window.localStorage.setItem(GROUP_BY_STORAGE_KEY, value);
  } catch {
    // Remembering the choice is optional.
  }
}

function downloadJson(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Some browsers start the download after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const SELECT_CLASS = "w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none";

function modelsCount(n: number): string {
  return `${n} ${n === 1 ? "model" : "models"}`;
}

export function CompanyModels() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  // The "Ready?" checklist on each saved model: the company's model settings and the last model-server readings.
  const readinessSources = useModelReadinessSources(selectedCompanyId);
  const canManage = role.canManageConnections;
  const [editing, setEditing] = useState<ModelDirectoryEntry | null>(null);
  /** For "Add this way to run it": the new setup starts from these values. */
  const [dialogInitial, setDialogInitial] = useState<CreateModelDirectoryEntry | null>(null);
  const [syncOutcomes, setSyncOutcomes] = useState<SyncOutcome[] | null>(null);
  /** Set when Resync was pressed while the company has no local address at all. */
  const [resyncNeedsAddress, setResyncNeedsAddress] = useState(false);
  /** Kept after the result panel is closed: the add dialog suggests these tags first. */
  const [lastSync, setLastSync] = useState<SyncOutcome[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<ModelDirectoryEntry | null>(null);
  const [checkingUp, setCheckingUp] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const [search, setSearch] = useState("");
  const [groupBy, setGroupByState] = useState<CatalogueGroupBy>(readGroupBy);
  const [where, setWhere] = useState<CatalogueWhereFilter>("all");
  const [use, setUse] = useState<CatalogueUseFilter>("all");
  const [status, setStatus] = useState<CatalogueStatusFilter>("all");
  const [tags, setTags] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<CatalogueSort>("name");
  const [criterion, setCriterion] = useState("");
  const setGroupBy = (value: CatalogueGroupBy) => {
    setGroupByState(value);
    writeGroupBy(value);
  };

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Models" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  // Archived setups are fetched too (they are hidden below unless asked for)
  // under their own key, so agent pickers that share the plain key never see them.
  const listQuery = useQuery({
    queryKey: [...queryKeys.companies.modelDirectory(selectedCompanyId ?? ""), "with-archived"],
    queryFn: () => modelDirectoryApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: Boolean(selectedCompanyId),
  });
  const startersQuery = useQuery({
    queryKey: queryKeys.companies.modelStarters(selectedCompanyId ?? ""),
    queryFn: () => modelDirectoryApi.listStarters(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && canManage,
    retry: false,
  });
  const settingsQuery = useModelDirectorySettings(selectedCompanyId);
  const gpuVramGb = settingsQuery.data?.localGpuVramGb ?? null;
  const localBaseUrl = settingsQuery.data?.localBaseUrl ?? null;
  const entries = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  /** Where new local setups point: the company's model server address, else the saved one; null = ask. */
  const localAddress = useMemo(() => defaultLocalAddress(localBaseUrl, entries), [localBaseUrl, entries]);
  const missingStarters = (startersQuery.data ?? []).filter((starter) => !starter.alreadyAdded);

  const filters = { search, where, use, availability: status, tags, showArchived, criterion };
  const filtersOn = hasActiveFilters(filters);
  const visible = useMemo(
    () => filterEntries(entries, { search, where, use, availability: status, tags, showArchived, criterion }),
    [entries, search, where, use, status, tags, showArchived, criterion],
  );
  const groups = useMemo(() => {
    const compare = compareEntriesBy(sort, criterion);
    return groupEntries(visible, groupBy).map((group) => ({ ...group, entries: [...group.entries].sort(compare) }));
  }, [visible, groupBy, sort, criterion]);
  // Known sizes and ways to run them are offered unless a filter narrows the list to what is saved.
  const offerKnown = where === "all" && use === "all" && status === "all" && tags.length === 0 && !criterion;
  const tree = useMemo(
    () =>
      buildModelTree(visible, {
        gpuVramGb,
        includeKnown: offerKnown,
        localAddress,
        sort,
        criterion,
      }),
    [visible, gpuVramGb, offerKnown, localAddress, sort, criterion],
  );
  const criteria = useMemo(() => criteriaInUse(entries), [entries]);
  const installedTags = useMemo(
    () => lastSync.flatMap((outcome) => outcome.result?.installed.map((model) => model.name) ?? []),
    [lastSync],
  );
  const duplicates = useMemo(() => findDuplicates(entries.filter((entry) => !entry.archivedAt)), [entries]);
  const tagOptions = useMemo(
    () => [...new Set([...tagsInUse(showArchived ? entries : entries.filter((e) => !e.archivedAt)), ...tags])].sort(),
    [entries, showArchived, tags],
  );
  const cloudProviders = useMemo(() => cloudProvidersInUse(entries), [entries]);
  const archivedCount = entries.filter((entry) => entry.archivedAt).length;

  const clearFilters = () => {
    setSearch("");
    setWhere("all");
    setUse("all");
    setStatus("all");
    setTags([]);
    setCriterion("");
  };

  const refresh = () => {
    if (!selectedCompanyId) return;
    // Prefix match: refreshes this page's list, the agent pickers' list and the starters.
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.modelDirectory(selectedCompanyId) });
  };
  const fail = (doing: string) => (error: unknown) =>
    pushToast({ title: modelErrorMessage(error, doing), tone: "error" });

  const saveMutation = useMutation({
    mutationFn: (body: CreateModelDirectoryEntry) =>
      editing
        ? modelDirectoryApi.update(selectedCompanyId!, editing.id, body as UpdateModelDirectoryEntry)
        : modelDirectoryApi.create(selectedCompanyId!, body),
    onSuccess: () => {
      refresh();
      setDialogOpen(false);
      pushToast({ title: editing ? "Model setup saved" : "Model added", tone: "success" });
    },
    onError: fail("save this model setup"),
  });
  const duplicateMutation = useMutation({
    mutationFn: (entry: ModelDirectoryEntry) => modelDirectoryApi.duplicate(selectedCompanyId!, entry.id),
    onSuccess: () => {
      refresh();
      pushToast({ title: "Copy made", tone: "success" });
    },
    onError: fail("copy this model setup"),
  });
  const favoriteMutation = useMutation({
    mutationFn: (entry: ModelDirectoryEntry) =>
      modelDirectoryApi.update(selectedCompanyId!, entry.id, { favorite: !entry.favorite }),
    onSuccess: refresh,
    onError: fail("change favourites"),
  });
  const archiveMutation = useMutation({
    mutationFn: (entry: ModelDirectoryEntry) =>
      modelDirectoryApi.update(selectedCompanyId!, entry.id, { archived: !entry.archivedAt }),
    onSuccess: (_saved, entry) => {
      refresh();
      pushToast({
        title: entry.archivedAt ? `"${entry.name}" restored` : `"${entry.name}" archived`,
        body: entry.archivedAt
          ? "Agents can pick it again."
          : "Agents can no longer pick it. Agents already using it keep working. Switch on Show archived to see it.",
        tone: "success",
      });
    },
    onError: fail("archive or restore this model setup"),
  });
  const deleteMutation = useMutation({
    mutationFn: (entry: ModelDirectoryEntry) => modelDirectoryApi.remove(selectedCompanyId!, entry.id),
    onSuccess: () => {
      refresh();
      setDeleting(null);
      pushToast({ title: "Model setup deleted", tone: "success" });
    },
    onError: (error) => {
      setDeleting(null);
      fail("delete this model setup")(error);
    },
  });
  const startersMutation = useMutation({
    mutationFn: (starterIds?: string[]) => modelDirectoryApi.addStarters(selectedCompanyId!, starterIds),
    onSuccess: (result) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.modelStarters(selectedCompanyId!) });
      const skipped = result.skipped ?? [];
      if (result.created.length > 0) {
        pushToast({
          title: `${modelsCount(result.created.length)} added`,
          ...(skipped.length > 0
            ? { body: `${modelsCount(skipped.length)} not added: ${skipped[0]!.reason}` }
            : {}),
          tone: "success",
        });
      } else if (skipped.length > 0) {
        pushToast({ title: "Nothing added", body: skipped[0]!.reason, tone: "error" });
      } else {
        pushToast({ title: "Those models are already in the list", tone: "success" });
      }
    },
    onError: fail("add the ready-made models"),
  });
  const exportMutation = useMutation({
    mutationFn: () => modelDirectoryApi.exportCatalogue(selectedCompanyId!),
    onSuccess: (file) => {
      downloadJson(catalogueFileName(selectedCompany?.name), file);
      pushToast({ title: `Exported ${modelsCount(file.entries.length)}`, tone: "success" });
    },
    onError: fail("export the models"),
  });

  const resyncMutation = useLocalResync(
    selectedCompanyId ?? "",
    entries,
    localBaseUrl,
    (error) => modelErrorMessage(error, "check which models are installed"),
    () => refresh(),
  );
  const resync = () => {
    if (resyncTargets(localBaseUrl, entries).length === 0) {
      setResyncNeedsAddress(true);
      return;
    }
    setResyncNeedsAddress(false);
    resyncMutation.mutate(undefined, {
      onSuccess: (outcomes) => {
        setSyncOutcomes(outcomes);
        setLastSync(outcomes);
      },
    });
  };
  useEffect(() => {
    if (localBaseUrl) setResyncNeedsAddress(false);
  }, [localBaseUrl]);

  const openAdd = (initial: CreateModelDirectoryEntry | null) => {
    setEditing(null);
    setDialogInitial(initial);
    setDialogOpen(true);
  };

  const busyId = (mutation: { isPending: boolean; variables?: ModelDirectoryEntry }) =>
    mutation.isPending ? mutation.variables?.id : undefined;
  const busyIds = new Set(
    [busyId(favoriteMutation), busyId(archiveMutation), busyId(duplicateMutation)].filter(Boolean) as string[],
  );

  const copyText = (text: string, what: string) => {
    copyTextToClipboard(text).then(
      () => pushToast({ title: `${what} copied`, tone: "success" }),
      () => pushToast({ title: `Could not copy. Select the text and copy it by hand.`, tone: "error" }),
    );
  };

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  const renderRow = (entry: ModelDirectoryEntry) => (
    <ModelCatalogueRow
      key={entry.id}
      entry={entry}
      readiness={modelReadiness(setupFromEntry(entry), {
        companyLocalBaseUrl: readinessSources.settings?.localBaseUrl ?? null,
        gpuVramGb: readinessSources.settings?.localGpuVramGb ?? null,
        blockedHosts: readinessSources.settings?.openrouterBlockedHosts ?? [],
        health: healthReading(readinessSources.healthByEntryId.get(entry.id)),
      })}
      companyId={selectedCompanyId}
      sameModelAs={duplicates.get(entry.id)}
      canManage={canManage}
      expanded={expanded.has(entry.id)}
      checkingUp={checkingUp === entry.id}
      busy={busyIds.has(entry.id)}
      onToggleExpanded={() =>
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(entry.id)) next.delete(entry.id);
          else next.add(entry.id);
          return next;
        })
      }
      onToggleCheckUp={() => setCheckingUp(checkingUp === entry.id ? null : entry.id)}
      onToggleFavorite={() => favoriteMutation.mutate(entry)}
      onEdit={() => {
        setEditing(entry);
        setDialogInitial(null);
        setDialogOpen(true);
      }}
      onDuplicate={() => duplicateMutation.mutate(entry)}
      onToggleArchived={() => archiveMutation.mutate(entry)}
      onDelete={() => setDeleting(entry)}
      onCopyText={copyText}
    />
  );

  const activeCount = entries.length - archivedCount;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Models</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {entries.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                disabled={exportMutation.isPending}
                onClick={() => exportMutation.mutate()}
                data-testid="models-export"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" /> Export
              </Button>
            )}
            {canManage && (
              <ModelCatalogueImport companyId={selectedCompanyId} existing={entries} onImported={refresh} />
            )}
            {canManage && (
              <Button size="sm" onClick={() => openAdd(null)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> Add a model
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Save each model once, with its address and settings. Then switch any quick agent to it in one click.
          Keys are not stored here; they stay under Connections.
        </p>
        <div className="space-y-3 rounded-lg border border-border p-3" data-testid="models-local-setup">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Local models (on your own computer)</p>
            <p className="text-xs text-muted-foreground">
              Only needed if this company runs models on its own computer with Ollama or a similar model server. Both
              settings are for this company only; cloud models do not use them.
            </p>
          </div>
          <LocalAddressField
            companyId={selectedCompanyId}
            settings={settingsQuery.data}
            canManage={canManage}
            onError={fail("save the model server address")}
          />
          <GpuMemoryField
            companyId={selectedCompanyId}
            settings={settingsQuery.data}
            canManage={canManage}
            onError={fail("save the graphics card memory")}
          />
          {canManage && <ResyncButton pending={resyncMutation.isPending} onClick={resync} />}
          {resyncNeedsAddress && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="models-resync-needs-address">
              {NEEDS_ADDRESS_FOR_RESYNC}
            </p>
          )}
        </div>
        <OpenRouterHostRules
          companyId={selectedCompanyId}
          settings={settingsQuery.data}
          entries={entries}
          canManage={canManage}
          onError={fail("save the OpenRouter host lists")}
        />
        {syncOutcomes && (
          <LocalSyncResults
            outcomes={syncOutcomes}
            entries={entries}
            canManage={canManage}
            gpuVramGb={gpuVramGb}
            onAdd={openAdd}
            onClose={() => setSyncOutcomes(null)}
          />
        )}
        {!canManage && !role.isLoading && (
          <p className="text-xs text-muted-foreground" data-testid="models-read-only-note">
            You can see the saved models and settings here, but not change them. Only the company owner or an admin
            can add, edit, archive or delete models, or change the settings above (including the OpenRouter hosts).
          </p>
        )}
      </div>

      {listQuery.isError ? (
        <p className="flex items-center gap-2 text-sm text-destructive" data-testid="models-error">
          <AlertCircle className="h-4 w-4" />
          {modelErrorMessage(listQuery.error, "see the saved models")}
          <Button variant="ghost" size="sm" onClick={() => listQuery.refetch()}>
            Try again
          </Button>
        </p>
      ) : listQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading your models…</p>
      ) : entries.length === 0 ? (
        <Card data-testid="models-empty">
          <CardHeader>
            <CardTitle className="text-sm">No models saved yet</CardTitle>
            <CardDescription>
              {canManage
                ? "Add your first model above, import a models file, or start with the ready-made ones below."
                : "An owner or admin can add the first one."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3" data-testid="models-toolbar">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  value={search}
                  placeholder="Search name, model id, maker, tags or notes"
                  aria-label="Search models"
                  onChange={(event) => setSearch(event.target.value)}
                  data-testid="models-search"
                />
              </div>
              <label className="space-y-1 text-xs text-muted-foreground sm:w-56">
                <span className="flex items-center gap-1">
                  Group by <HelpTip topic="group by" text={MODEL_HELP.groupBy} />
                </span>
                <select
                  className={SELECT_CLASS}
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value as CatalogueGroupBy)}
                  data-testid="models-group-by"
                >
                  {CATALOGUE_GROUP_BY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:items-end">
              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  Sort <HelpTip topic="sort" text={MODEL_HELP.sort} />
                </span>
                <select
                  className={SELECT_CLASS}
                  value={sort}
                  onChange={(event) => setSort(event.target.value as CatalogueSort)}
                  data-testid="models-sort"
                >
                  <option value="name">By name</option>
                  <option value="rating">By test scores (best first)</option>
                </select>
              </label>
              {criteria.length > 0 && (
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    Best for <HelpTip topic="best for" text={MODEL_HELP.bestFor} />
                  </span>
                  <select
                    className={SELECT_CLASS}
                    value={criterion}
                    onChange={(event) => {
                      setCriterion(event.target.value);
                      if (event.target.value) setSort("rating");
                    }}
                    data-testid="models-filter-criterion"
                  >
                    <option value="">Anything</option>
                    {criteria.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:items-end">
              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  Where it runs <HelpTip topic="where it runs" text={MODEL_HELP.where} />
                </span>
                <select
                  className={SELECT_CLASS}
                  value={where}
                  onChange={(event) => setWhere(event.target.value as CatalogueWhereFilter)}
                  data-testid="models-filter-where"
                >
                  <option value="all">Anywhere</option>
                  <option value="local">{whereLabel("local")}</option>
                  <option value="cloud">In the cloud</option>
                  {cloudProviders.map((provider) => (
                    <option key={provider} value={provider}>
                      {whereLabel(provider)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  What it's for <HelpTip topic="what it's for" text={MODEL_HELP.use} />
                </span>
                <select
                  className={SELECT_CLASS}
                  value={use}
                  onChange={(event) => setUse(event.target.value as CatalogueUseFilter)}
                  data-testid="models-filter-use"
                >
                  <option value="all">Anything</option>
                  <option value="quick">Quick chat</option>
                  <option value="full">Full runs</option>
                  <option value="both">Both</option>
                  <option value="unset">Not set</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  Status <HelpTip topic="status" text={MODEL_HELP.status} />
                </span>
                <select
                  className={SELECT_CLASS}
                  value={status}
                  onChange={(event) => setStatus(event.target.value as CatalogueStatusFilter)}
                  data-testid="models-filter-status"
                >
                  <option value="all">Any status</option>
                  <option value="installed">Installed</option>
                  <option value="downloading">Downloading</option>
                  <option value="planned">Planned</option>
                  <option value="cloud">Cloud</option>
                  <option value="unset">Not set</option>
                </select>
              </label>
              <label className="flex h-[34px] items-center gap-2 text-sm">
                <ToggleSwitch
                  checked={showArchived}
                  onCheckedChange={setShowArchived}
                  aria-label="Show archived"
                  data-testid="models-show-archived"
                />
                Show archived
                <HelpTip topic="show archived" text={MODEL_HELP.archived} />
              </label>
            </div>

            {tagOptions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="models-tags">
                <span className="text-xs text-muted-foreground">Tags:</span>
                {tagOptions.map((tag) => {
                  const on = tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setTags(on ? tags.filter((t) => t !== tag) : [...tags, tag])}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs",
                        on
                          ? "border-foreground bg-foreground text-background"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                      data-testid={`models-tag-${tag}`}
                    >
                      #{tag}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span data-testid="models-counts">
                {countsLine(entries, filtersOn || (showArchived && archivedCount > 0) ? visible.length : undefined)}
              </span>
              {filtersOn && (
                <Button size="xs" variant="ghost" onClick={clearFilters} data-testid="models-clear-filters">
                  Clear filters
                </Button>
              )}
            </div>
          </div>

          {visible.length === 0 ? (
            <Card data-testid="models-no-match">
              <CardHeader>
                <CardTitle className="text-sm">
                  {activeCount === 0 && !showArchived ? "Every saved model is archived" : "No models match"}
                </CardTitle>
                <CardDescription>
                  {activeCount === 0 && !showArchived
                    ? "Switch on Show archived to see them."
                    : "Try other words, or clear the filters."}
                </CardDescription>
              </CardHeader>
            </Card>
          ) : groupBy === "maker" ? (
            <ModelCatalogueTree
              makers={tree}
              canManage={canManage}
              gpuKnown={gpuVramGb !== null}
              gpuVramGb={gpuVramGb}
              renderRow={renderRow}
              onAdd={openAdd}
              onCopyText={copyText}
            />
          ) : groupBy === "none" ? (
            <ul className="space-y-2" data-testid="models-list">
              {groups[0]?.entries.map(renderRow)}
            </ul>
          ) : (
            <div className="section-box space-y-4 rounded-lg p-4" data-testid="models-list">
              {groups.map((group) => {
                const subgroups = group.subgroups ?? [];
                // One "No base model" bucket alone needs no heading.
                const showSubHeadings = subgroups.length > 1 || (subgroups.length === 1 && !subgroups[0]!.unset);
                return (
                  <SettingsSubsection
                    key={group.key}
                    title={group.title}
                    summary={modelsCount(group.entries.length)}
                    storageKey={`models.group.${group.key}`}
                    data-testid={`models-group-${group.key}`}
                  >
                    {subgroups.length > 0 ? (
                      subgroups.map((sub) => (
                        <div key={sub.key} className="space-y-2">
                          {showSubHeadings && (
                            <div className="text-xs font-medium text-muted-foreground">
                              {sub.title} <span className="font-normal">· {sub.entries.length}</span>
                            </div>
                          )}
                          <ul className="space-y-2">{sub.entries.map(renderRow)}</ul>
                        </div>
                      ))
                    ) : (
                      <ul className="space-y-2">{group.entries.map(renderRow)}</ul>
                    )}
                  </SettingsSubsection>
                );
              })}
            </div>
          )}
        </div>
      )}

      {canManage && missingStarters.length > 0 && (
        <div className="space-y-2" data-testid="models-starters">
          <div className="section-title">Ready-made models</div>
          <p className="text-xs text-muted-foreground">
            Models known to work well with Paperclip. Adding one just saves it to the list above; you can edit or
            delete it afterwards. Local ones are not installed for you: they start as "Planned" and use this company's
            model server address.
          </p>
          {!localBaseUrl && missingStarters.some((starter) => starter.provider === "local") && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="models-starters-needs-address">
              To add the local ones, set the model server address at the top of this page first. The cloud ones can be
              added now.
            </p>
          )}
          <ul className="space-y-2">
            {missingStarters.map((starter) => (
              <li
                key={starter.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {starter.name}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      · {starter.provider === "local" ? "local" : whereLabel(starter.provider)}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">{starter.note}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={startersMutation.isPending || (starter.provider === "local" && !localBaseUrl)}
                  title={starter.provider === "local" && !localBaseUrl ? "Set the model server address at the top first" : undefined}
                  onClick={() => startersMutation.mutate([starter.id])}
                  data-testid={`models-starter-add-${starter.id}`}
                >
                  Add
                </Button>
              </li>
            ))}
          </ul>
          {missingStarters.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              disabled={startersMutation.isPending}
              onClick={() => startersMutation.mutate(undefined)}
            >
              Add all ready-made models
            </Button>
          )}
        </div>
      )}

      {canManage && (
        <ModelEntryDialog
          open={dialogOpen}
          entry={editing}
          initial={dialogInitial}
          installedTags={installedTags}
          localAddress={localAddress}
          gpuVramGb={gpuVramGb}
          allEntries={entries}
          companyId={selectedCompanyId}
          hostRules={
            settingsQuery.data
              ? {
                  preferred: settingsQuery.data.openrouterPreferredHosts ?? [],
                  blocked: settingsQuery.data.openrouterBlockedHosts ?? [],
                }
              : null
          }
          busy={saveMutation.isPending}
          onClose={() => setDialogOpen(false)}
          onSave={(body) => saveMutation.mutate(body)}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{deleting?.name}"?</DialogTitle>
            <DialogDescription>
              It will be removed from the list. Agents that use it keep working with the settings they have now.
              {deleting && !deleting.archivedAt && " To keep it but hide it from agents, archive it instead."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleting && deleteMutation.mutate(deleting)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LANE_A_PROVIDER_CATALOGUE,
  LANE_A_PROVIDERS,
  type CreateModelDirectoryEntry,
  type LaneAProvider,
  type ModelDirectoryEntry,
  type UpdateModelDirectoryEntry,
} from "@paperclipai/shared";
import { AlertCircle, Copy, Cpu, Loader2, Pencil, Plus, Stethoscope, Trash2 } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { ModelReviewPanel } from "../components/ModelReviewPanel";
import { modelDirectoryApi } from "../api/modelDirectory";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Settings > Models: the company's saved model setups. A setup is a name plus
 * the provider, model, address and defaults a quick agent needs, so switching
 * an agent's model is one pick instead of retyping five fields. No key is ever
 * part of a setup; keys stay under Connections.
 *
 * Only the company owner and admins may change setups (the server enforces
 * it; this page just hides the buttons and says so in plain words when a
 * request is refused).
 */

export function providerLabel(provider: LaneAProvider): string {
  return LANE_A_PROVIDER_CATALOGUE[provider]?.label ?? provider;
}

/** Plain-English text for any failed request on this page. */
export function modelErrorMessage(error: unknown, doing: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return `Only the company owner or an admin can ${doing}.`;
    if (error.status === 409) return "Another model setup already has that name. Pick a different name.";
    return error.message;
  }
  return `Could not ${doing}. Please try again.`;
}

type FormState = {
  name: string;
  provider: LaneAProvider;
  model: string;
  baseUrl: string;
  thinking: "" | "on" | "off";
  temperature: string;
  maxOutputTokens: string;
  note: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  provider: "local",
  model: "",
  baseUrl: "",
  thinking: "",
  temperature: "",
  maxOutputTokens: "",
  note: "",
};

function formFromEntry(entry: ModelDirectoryEntry): FormState {
  return {
    name: entry.name,
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl ?? "",
    thinking: entry.defaultThinking ?? "",
    temperature: entry.defaultTemperature === null ? "" : String(entry.defaultTemperature),
    maxOutputTokens: entry.defaultMaxOutputTokens === null ? "" : String(entry.defaultMaxOutputTokens),
    note: entry.note ?? "",
  };
}

/** The address only applies to a model server you run yourself. */
export function providerUsesAddress(provider: LaneAProvider): boolean {
  return provider === "local";
}

/** Fields to send; anything that does not apply to the provider is cleared so nothing stale lingers. */
export function bodyFromForm(form: FormState): CreateModelDirectoryEntry {
  const temperature = form.temperature.trim() === "" ? null : Number(form.temperature);
  const maxTokens = form.maxOutputTokens.trim() === "" ? null : Number(form.maxOutputTokens);
  return {
    name: form.name,
    provider: form.provider,
    model: form.model,
    baseUrl: providerUsesAddress(form.provider) && form.baseUrl.trim() ? form.baseUrl.trim() : null,
    ...(form.provider === "openrouter" ? {} : { providerRouting: null }),
    defaultThinking: form.thinking === "" ? null : form.thinking,
    defaultTemperature: temperature,
    defaultMaxOutputTokens: maxTokens,
    note: form.note.trim() ? form.note.trim() : null,
  };
}

function EntryDialog({
  open,
  entry,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  entry: ModelDirectoryEntry | null;
  busy: boolean;
  onClose: () => void;
  onSave: (body: CreateModelDirectoryEntry) => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  useEffect(() => {
    if (open) setForm(entry ? formFromEntry(entry) : EMPTY_FORM);
  }, [open, entry]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const canSave = form.name.trim() !== "" && form.model.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg" data-testid="model-entry-dialog">
        <DialogHeader>
          <DialogTitle>{entry ? "Edit model setup" : "Add a model setup"}</DialogTitle>
          <DialogDescription>
            Save a model once, then pick it for any quick agent. Keys are not saved here; they stay under
            Connections.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="model-name">Name</Label>
            <Input
              id="model-name"
              value={form.name}
              placeholder="Maja on my PC"
              onChange={(event) => set("name", event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="model-provider">Where it runs</Label>
            <select
              id="model-provider"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={form.provider}
              onChange={(event) => set("provider", event.target.value as LaneAProvider)}
            >
              {LANE_A_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="model-id">Model name</Label>
            <Input
              id="model-id"
              value={form.model}
              placeholder={form.provider === "openrouter" ? "mistralai/mistral-small-3.2-24b-instruct" : "llama3.2"}
              onChange={(event) => set("model", event.target.value)}
            />
          </div>
          {providerUsesAddress(form.provider) && (
            <div className="space-y-1">
              <Label htmlFor="model-address">Address of your model server</Label>
              <Input
                id="model-address"
                value={form.baseUrl}
                placeholder="http://100.124.232.68:11434/v1"
                onChange={(event) => set("baseUrl", event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Your PC must be switched on for this to work.</p>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label htmlFor="model-thinking">Thinking</Label>
              <select
                id="model-thinking"
                className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none"
                value={form.thinking}
                onChange={(event) => set("thinking", event.target.value as FormState["thinking"])}
              >
                <option value="">Model's own choice</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-creativity">Creativity</Label>
              <Input
                id="model-creativity"
                inputMode="decimal"
                value={form.temperature}
                placeholder="Default"
                onChange={(event) => set("temperature", event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-length">Answer length</Label>
              <Input
                id="model-length"
                inputMode="numeric"
                value={form.maxOutputTokens}
                placeholder="Default"
                onChange={(event) => set("maxOutputTokens", event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="model-note">Note (optional)</Label>
            <Textarea
              id="model-note"
              rows={2}
              value={form.note}
              onChange={(event) => set("note", event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onSave(bodyFromForm(form))} disabled={!canSave || busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {entry ? "Save changes" : "Add model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CompanyModels() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  const canManage = role.canManageConnections;
  const [editing, setEditing] = useState<ModelDirectoryEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<ModelDirectoryEntry | null>(null);
  const [checkingUp, setCheckingUp] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Models" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const listQuery = useQuery({
    queryKey: queryKeys.companies.modelDirectory(selectedCompanyId ?? ""),
    queryFn: () => modelDirectoryApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const startersQuery = useQuery({
    queryKey: queryKeys.companies.modelStarters(selectedCompanyId ?? ""),
    queryFn: () => modelDirectoryApi.listStarters(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && canManage,
    retry: false,
  });
  const entries = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const missingStarters = (startersQuery.data ?? []).filter((starter) => !starter.alreadyAdded);

  const refresh = () => {
    if (!selectedCompanyId) return;
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
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.modelStarters(selectedCompanyId!) });
      pushToast({ title: "Ready-made models added", tone: "success" });
    },
    onError: fail("add the ready-made models"),
  });

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Models</h1>
          </div>
          {canManage && (
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add a model
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Save each model once, with its address and settings. Then switch any quick agent to it in one click.
          Keys are not stored here; they stay under Connections.
        </p>
        {!canManage && !role.isLoading && (
          <p className="text-xs text-muted-foreground" data-testid="models-read-only-note">
            You can see the saved models here. Only the company owner or an admin can add or change them.
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
                ? "Add your first model below, or start with the ready-made ones."
                : "An owner or admin can add the first one."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="space-y-3" data-testid="models-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Card data-testid={`model-card-${entry.id}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <CardTitle className="text-sm">{entry.name}</CardTitle>
                      <CardDescription>
                        {providerLabel(entry.provider)} · {entry.model}
                      </CardDescription>
                    </div>
                    <Badge variant="outline">{entry.provider === "local" ? "On your PC" : "Online"}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  {entry.baseUrl && <p>Address: {entry.baseUrl}</p>}
                  {entry.note && <p>{entry.note}</p>}
                  <div className="flex gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCheckingUp(checkingUp === entry.id ? null : entry.id)}
                    >
                      <Stethoscope className="mr-1.5 h-3.5 w-3.5" />
                      {checkingUp === entry.id ? "Hide check-up" : "Check-up"}
                    </Button>
                  </div>
                  {checkingUp === entry.id && (
                    <ModelReviewPanel companyId={selectedCompanyId} entryId={entry.id} canManage={canManage} />
                  )}
                  {canManage && (
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditing(entry);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={duplicateMutation.isPending}
                        onClick={() => duplicateMutation.mutate(entry)}
                      >
                        <Copy className="mr-1.5 h-3.5 w-3.5" /> Make a copy
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(entry)}>
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {canManage && missingStarters.length > 0 && (
        <div className="space-y-2" data-testid="models-starters">
          <div className="section-title">Ready-made models</div>
          <p className="text-xs text-muted-foreground">
            Models we already know work well. Adding one just saves it to the list above.
          </p>
          <ul className="space-y-2">
            {missingStarters.map((starter) => (
              <li
                key={starter.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{starter.name}</p>
                  <p className="text-xs text-muted-foreground">{starter.note}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={startersMutation.isPending}
                  onClick={() => startersMutation.mutate([starter.id])}
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
        <EntryDialog
          open={dialogOpen}
          entry={editing}
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

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Plus, X } from "lucide-react";
import {
  isTestableSecretKind,
  secretValueLooksWrongForKind,
  type CompanySecret,
  type CompanySecretTestResult,
  type SecretKind,
  type SecretVersionSelector,
} from "@paperclipai/shared";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { SecretKindSelect } from "./SecretKindSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

export interface SecretBindingValue {
  secretId: string;
  version?: SecretVersionSelector;
}

interface SecretBindingPickerProps {
  value: SecretBindingValue | null;
  onChange: (next: SecretBindingValue | null) => void;
  label?: string;
  placeholder?: string;
  allowVersionSelector?: boolean;
  emptyHint?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Optional whitelist of secret statuses to show. Defaults to "active".
   * Pass null to disable the filter and show every secret in the company.
   */
  statusFilter?: Array<CompanySecret["status"]> | null;
  /**
   * DUR-3997: optional ordering. Lower ranks first; ties keep the server's
   * order. Lets a caller put the secrets that look like a provider's key
   * (by kind when the company has tagged them, else by name) at the top
   * without hiding the rest.
   */
  rankSecret?: (secret: CompanySecret) => number;
}

const VERSION_LATEST: SecretVersionSelector = "latest";

/**
 * DUR-3997: the last row of the dropdown. Picking it opens the "Add new
 * secret" dialog instead of binding anything. The select is controlled, so
 * it snaps back to the real selection on the next render.
 */
export const ADD_NEW_SECRET_OPTION = "__add_new_secret__";
export const ADD_NEW_SECRET_LABEL = "Add new secret…";

/** Shown instead of the caller's empty hint to someone who cannot add one. */
const READ_ONLY_EMPTY_HINT = "No secrets yet. A company owner or admin can add one.";

/** What the dialog reports after saving. Never carries the value. */
interface JustAdded {
  secretId: string;
  name: string;
  verdict: Pick<CompanySecretTestResult, "ok" | "message"> | null;
}

function describeSecret(secret: CompanySecret): string {
  const provider = secret.provider.replaceAll("_", " ");
  if (secret.managedMode === "external_reference") {
    return `External · ${provider}`;
  }
  return provider;
}

function statusTone(status: CompanySecret["status"]): string {
  switch (status) {
    case "active":
      return "text-emerald-600 dark:text-emerald-400";
    case "disabled":
      return "text-amber-600 dark:text-amber-400";
    case "archived":
      return "text-muted-foreground";
    case "deleted":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function SecretBindingPicker({
  value,
  onChange,
  label = "Secret",
  placeholder = "Select secret",
  allowVersionSelector = true,
  emptyHint = `No matching secrets. Pick "${ADD_NEW_SECRET_LABEL}" to add one here.`,
  className,
  disabled,
  statusFilter = ["active"],
  rankSecret,
}: SecretBindingPickerProps) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  // DUR-3997: adding a credential is a board action (owner, admin, instance
  // admin, or the local single-user board). Everyone else picks from the
  // list only. The server route has its own check; this decides what to draw.
  const { canManageConnections } = useCompanyRole(selectedCompanyId);
  const canAdd = canManageConnections && Boolean(selectedCompanyId) && !disabled;

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKind, setCreateKind] = useState<SecretKind | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<JustAdded | null>(null);

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.list(selectedCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const filteredSecrets = useMemo(() => {
    const all = secretsQuery.data ?? [];
    const kept = statusFilter === null ? all : all.filter((secret) => statusFilter.includes(secret.status));
    if (!rankSecret) return kept;
    // Stable: equal ranks keep the order the server returned them in.
    return kept
      .map((secret, index) => ({ secret, index, rank: rankSecret(secret) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.secret);
  }, [secretsQuery.data, statusFilter, rankSecret]);

  const selectedSecret = useMemo(() => {
    if (!value) return null;
    return (secretsQuery.data ?? []).find((secret) => secret.id === value.secretId) ?? null;
  }, [secretsQuery.data, value]);

  // The list may still be refetching right after a save; the dialog's own
  // answer bridges that gap so the field never looks "missing" for a moment.
  const selectedMissing = Boolean(value && !selectedSecret && value.secretId !== justAdded?.secretId);
  const showJustAdded = Boolean(justAdded && value?.secretId === justAdded.secretId);

  const valueLooksWrong = secretValueLooksWrongForKind(createKind, createValue);
  const createTestable = isTestableSecretKind(createKind);

  function resetCreateForm() {
    setCreateName("");
    setCreateKind(null);
    setCreateValue("");
    setCreateError(null);
  }

  function closeCreate() {
    setCreateOpen(false);
    resetCreateForm();
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const created = await secretsApi.create(selectedCompanyId!, {
        name: createName.trim(),
        value: createValue,
        kind: createKind,
      });
      // DUR-3997: an AI-provider key is checked with its provider straight
      // away, so a mistyped key shows up now and not on the first agent run.
      // The secret is kept and bound either way; a network blip is not an error.
      const verdict = isTestableSecretKind(created.kind)
        ? await secretsApi.test(selectedCompanyId!, created.id).catch(() => null)
        : null;
      return { created, verdict };
    },
    onSuccess: ({ created, verdict }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
      setJustAdded({
        secretId: created.id,
        name: created.name,
        verdict: verdict ? { ok: verdict.ok, message: verdict.message } : null,
      });
      onChange({ secretId: created.id, version: VERSION_LATEST });
      closeCreate();
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error.message : "Could not save the secret");
    },
  });

  const versionDisplay = (selector: SecretVersionSelector | undefined) => {
    if (selector === undefined || selector === VERSION_LATEST) return "latest";
    return `v${selector}`;
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <div className="flex items-center justify-between text-xs font-medium text-foreground/80">
          <span>{label}</span>
          {value ? (
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              onClick={() => onChange(null)}
              disabled={disabled}
            >
              <X className="h-3 w-3" /> Clear
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <KeyRound className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <select
            className={cn(
              "h-9 w-full rounded-md border border-border bg-background pl-7 pr-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60",
              selectedMissing && "border-destructive text-destructive",
            )}
            value={value?.secretId ?? ""}
            onChange={(event) => {
              const next = event.target.value;
              if (next === ADD_NEW_SECRET_OPTION) {
                setCreateOpen(true);
                return;
              }
              if (!next) {
                onChange(null);
                return;
              }
              onChange({ secretId: next, version: value?.version ?? VERSION_LATEST });
            }}
            disabled={disabled || secretsQuery.isPending}
            aria-label={label || placeholder}
          >
            <option value="">{secretsQuery.isPending ? "Loading…" : placeholder}</option>
            {selectedMissing && value ? (
              <option value={value.secretId}>Missing secret ({value.secretId.slice(0, 8)}…)</option>
            ) : null}
            {showJustAdded && justAdded && !selectedSecret ? (
              <option value={justAdded.secretId}>{justAdded.name}</option>
            ) : null}
            {filteredSecrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name} — {describeSecret(secret)}
              </option>
            ))}
            {canAdd ? <option value={ADD_NEW_SECRET_OPTION}>{ADD_NEW_SECRET_LABEL}</option> : null}
          </select>
        </div>
        {allowVersionSelector ? (
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-60"
            value={value?.version === undefined ? VERSION_LATEST : String(value.version)}
            onChange={(event) => {
              if (!value) return;
              const raw = event.target.value;
              const next: SecretVersionSelector = raw === VERSION_LATEST ? VERSION_LATEST : Number.parseInt(raw, 10);
              onChange({ ...value, version: next });
            }}
            disabled={disabled || !value || !selectedSecret}
            aria-label="Version"
          >
            <option value={VERSION_LATEST}>latest</option>
            {selectedSecret
              ? Array.from({ length: Math.max(0, selectedSecret.latestVersion) }, (_, index) => {
                  const version = selectedSecret.latestVersion - index;
                  if (version <= 0) return null;
                  return (
                    <option key={version} value={version}>
                      v{version}
                    </option>
                  );
                })
              : null}
          </select>
        ) : null}
        {canAdd ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreateOpen(true)}
            aria-label="Add new secret"
            title="Add new secret"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>

      {showJustAdded && justAdded ? (
        <p
          className={cn(
            "text-[11px] flex items-start gap-1",
            justAdded.verdict?.ok === false
              ? "text-amber-600 dark:text-amber-400"
              : "text-emerald-600 dark:text-emerald-400",
          )}
          data-testid="secret-just-added"
        >
          {justAdded.verdict?.ok === false ? (
            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
          )}
          <span>
            {justAdded.verdict
              ? justAdded.verdict.ok
                ? `Saved and checked: ${justAdded.verdict.message}`
                : `Saved, but the provider did not accept it: ${justAdded.verdict.message}`
              : `Saved "${justAdded.name}" to Secrets and picked it here.`}
          </span>
        </p>
      ) : selectedSecret ? (
        <p className={cn("text-[11px] text-muted-foreground", statusTone(selectedSecret.status))}>
          {selectedSecret.status !== "active" ? `Status: ${selectedSecret.status}. ` : null}
          Bound to {versionDisplay(value?.version)} · {selectedSecret.key}
        </p>
      ) : selectedMissing ? (
        <p className="text-[11px] text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          The previously selected secret is no longer available. Pick another or remove the binding.
        </p>
      ) : (filteredSecrets.length === 0 && !secretsQuery.isPending) ? (
        <p className="text-[11px] text-muted-foreground">
          {canAdd || disabled ? emptyHint : READ_ONLY_EMPTY_HINT}
        </p>
      ) : null}

      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          if (createMutation.isPending) return;
          if (next) setCreateOpen(true);
          else closeCreate();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add new secret</DialogTitle>
            <DialogDescription>
              Saved to Secrets like any other key, and picked here as soon as it is saved.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-name">Name</label>
              <Input
                id="secret-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="OPENAI_API_KEY"
                autoFocus
                disabled={createMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-kind">What kind of key is this?</label>
              <SecretKindSelect
                id="secret-kind"
                value={createKind}
                onChange={setCreateKind}
                disabled={createMutation.isPending}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-value">Value</label>
              <Textarea
                id="secret-value"
                value={createValue}
                onChange={(event) => setCreateValue(event.target.value)}
                rows={3}
                placeholder="Paste the secret value"
                className="min-w-0 overflow-x-hidden break-all font-mono text-xs"
                aria-invalid={valueLooksWrong}
                disabled={createMutation.isPending}
              />
              {valueLooksWrong ? (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                  That does not look like the usual shape for this kind of key. You can still save it.
                </p>
              ) : createTestable ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Paperclip will check it with the provider as soon as it is saved.
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Stored once and never shown again. Rotate it under Secrets to replace it.
                </p>
              )}
            </div>
            {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeCreate} disabled={createMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={!createName.trim() || !createValue || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {createMutation.isPending ? (createTestable ? "Saving and checking…" : "Saving…") : "Save & use"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

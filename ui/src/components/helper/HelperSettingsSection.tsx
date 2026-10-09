import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HelperModelOption, UpdateHelperSettings } from "@paperclipai/shared";
import { helperApi } from "../../api/helper";
import { agentsApi } from "../../api/agents";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { useToastActions } from "../../context/ToastContext";
import { Link } from "@/lib/router";
import { SecretBindingPicker } from "../SecretBindingPicker";
import { groupEntries, type CatalogueItem } from "../../lib/model-catalogue";
import { helperStatusText, isHelperStatusReady, sortByReadiness } from "./helper-model-status";

function toCatalogueItem(option: HelperModelOption): CatalogueItem {
  return {
    id: option.id,
    name: option.name,
    provider: option.provider,
    model: option.model,
    baseUrl: null,
    note: null,
    maker: option.maker,
    baseModel: option.baseModel,
    lane: (option.lane as CatalogueItem["lane"]) ?? null,
    availability: null,
    tags: [],
    specs: null,
    favorite: option.favorite,
    archivedAt: null,
    family: null,
    variant: null,
    ratings: [],
    providerRouting: null,
  };
}

/**
 * Company settings → General → Helper: which saved model "Ask Paperclip"
 * answers with by default, the keys it may use, and (reserved for a later
 * phase) which full agent takes deeper investigations. Everyone in the
 * company can see this; only an owner or admin can change it.
 */
export function HelperSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const settingsQuery = useQuery({
    queryKey: queryKeys.companies.helperSettings(companyId),
    queryFn: () => helperApi.getSettings(companyId),
    retry: false,
  });
  const settings = settingsQuery.data;
  const readOnly = !settings?.canEdit;
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(settings?.canEdit),
  });
  const mutation = useMutation({
    mutationFn: (patch: UpdateHelperSettings) => helperApi.updateSettings(companyId, patch),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.companies.helperSettings(companyId), next);
      pushToast({ title: "Helper settings saved", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: error instanceof ApiError ? error.message : "Could not save the helper settings", tone: "error" });
    },
  });
  const groups = useMemo(() => groupEntries((settings?.models ?? []).map(toCatalogueItem), "maker"), [settings?.models]);
  const optionsById = useMemo(() => new Map((settings?.models ?? []).map((m) => [m.id, m])), [settings?.models]);

  return (
    <div className="space-y-4" data-testid="helper-settings">
      <div className="section-title">Helper (Ask Paperclip)</div>
      <div className="space-y-4 rounded-md section-box px-4 py-4 text-sm">
        <p className="text-xs text-muted-foreground">
          The “Ask” button at the bottom right of every page (or Ctrl/Cmd+Shift+H) opens a helper that explains what is
          on the page. You can mark part of the page and ask about it. It only reads the text you choose to send, it
          cannot change anything, and each answer is counted in Costs like any other model call.
        </p>
        {settingsQuery.isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
        {settingsQuery.error ? (
          <p className="text-xs text-destructive">
            {settingsQuery.error instanceof Error ? settingsQuery.error.message : "Could not load the helper settings."}
          </p>
        ) : null}
        {settings ? (
          <>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Default model</span>
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm"
                value={settings.defaultDirectoryEntryId ?? ""}
                disabled={readOnly || mutation.isPending}
                onChange={(e) => mutation.mutate({ defaultDirectoryEntryId: e.target.value || null })}
                data-testid="helper-default-model"
              >
                <option value="">
                  Paperclip's default — {settings.builtInDefaultLabel} — {helperStatusText(settings.builtInDefaultStatus)}
                </option>
                {groups.map((group) => (
                  <optgroup key={group.key} label={group.title}>
                    {sortByReadiness(group.entries.map((entry) => ({ entry, option: optionsById.get(entry.id)! })).filter((x) => x.option)).map(
                      ({ entry, option }) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name} — {helperStatusText(option.status)}
                          {option.canSeePictures === true ? " · sees pictures" : ""}
                        </option>
                      ),
                    )}
                  </optgroup>
                ))}
              </select>
              {(() => {
                const picked = settings.defaultDirectoryEntryId ? optionsById.get(settings.defaultDirectoryEntryId) : null;
                const status = picked ? picked.status : settings.builtInDefaultStatus;
                return status && !isHelperStatusReady(status) ? (
                  <span className="block text-xs text-amber-600" data-testid="helper-default-model-warning">
                    {helperStatusText(status)}: {status.detail}
                  </span>
                ) : null;
              })()}
              <span className="block text-xs text-muted-foreground">
                Used when the person asking leaves “Model” on “Use default”. A small, fast model is usually enough for
                explanations. The list is your saved models from{" "}
                <Link to="/company/settings/models" className="underline">
                  Models
                </Link>
                .
              </span>
              <span className="block text-xs text-muted-foreground">
                People can also attach pictures to a question (for example a screenshot or a photo). Only models that can
                look at pictures answer those, and the Ask panel says which ones can. Whether a saved model can see
                pictures is its “Pictures” setting under Models: Paperclip fills it in for models it knows, and you can
                change it there.
              </span>
            </label>

            <div className="space-y-2">
              <div className="text-xs font-medium">Keys the helper may use</div>
              <p className="text-xs text-muted-foreground">
                Pick one saved secret per model service. The helper never shows the key, and every use is logged on the
                secret. Claude can use Paperclip's own key when none is picked; a model on your own computer needs no key.
              </p>
              {settings.keys.map((key) => (
                <div key={key.provider} className="space-y-1" data-testid={`helper-key-${key.provider}`} data-helper-private>
                  <SecretBindingPicker
                    label={`${key.providerLabel} key`}
                    placeholder={
                      key.provider === "anthropic" && key.instanceFallback
                        ? "None — use Paperclip's own Claude key"
                        : `Pick the ${key.providerLabel} key`
                    }
                    value={key.secretId ? { secretId: key.secretId } : null}
                    onChange={(next) => mutation.mutate({ keys: { [key.provider]: next?.secretId ?? null } })}
                    allowVersionSelector={false}
                    disabled={readOnly || mutation.isPending}
                  />
                  {key.status === "unusable" ? (
                    <p className="text-xs text-amber-600">This secret is deleted or switched off. Pick another one.</p>
                  ) : null}
                </div>
              ))}
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-medium">Agent for deeper investigations (coming later)</span>
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm"
                value={settings.investigationAgentId ?? ""}
                disabled={readOnly || mutation.isPending}
                onChange={(e) => mutation.mutate({ investigationAgentId: e.target.value || null })}
              >
                <option value="">None</option>
                {(agentsQuery.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
                {settings.investigationAgentId && !(agentsQuery.data ?? []).some((a) => a.id === settings.investigationAgentId) ? (
                  <option value={settings.investigationAgentId}>Saved agent</option>
                ) : null}
              </select>
              <span className="block text-xs text-muted-foreground">
                Not used yet. Later, when a question needs real digging (reading tasks, runs or data), the helper will
                offer to hand it to this full agent as a task.
              </span>
            </label>
            {readOnly ? (
              <p className="text-xs text-muted-foreground">Only a company owner or admin can change these settings.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

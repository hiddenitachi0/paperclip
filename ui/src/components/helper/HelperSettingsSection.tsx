import { useMemo, useState } from "react";
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

const RUNNING_CHOICES = [1, 2, 3, 5, 10, 20];
const PER_DAY_CHOICES = [5, 10, 20, 50, 100, 200];
const COMPANY_PER_DAY_CHOICES = [10, 20, 50, 100, 200, 500, 1000];
export const INVESTIGATOR_CAN_WRITE_ACK =
  "I understand this agent can change things and text on screen could try to make it do so.";

interface CanWriteRefusal {
  agentId: string;
  agentName: string | null;
  capabilities: string[];
}

function canWriteRefusalOf(error: unknown): CanWriteRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { code?: string; details?: Partial<CanWriteRefusal> } | null;
  if (body?.code !== "HELPER_INVESTIGATOR_CAN_WRITE" || !body.details?.agentId) return null;
  return {
    agentId: body.details.agentId,
    agentName: body.details.agentName ?? null,
    capabilities: Array.isArray(body.details.capabilities) ? body.details.capabilities : [],
  };
}

/** The "this agent can change things" box with the confirmation checkbox. */
function CanWriteConfirm({
  agentName,
  capabilities,
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  agentName: string | null;
  capabilities: string[];
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel?: () => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 px-3 py-2 text-xs" role="alert" data-testid="helper-investigator-can-write">
      <p>
        “{agentName ?? "This agent"}” can change things, not just read:
      </p>
      <ul className="list-disc space-y-0.5 pl-5">
        {capabilities.map((c) => (
          <li key={c}>It {c}.</li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        The page text people send with a question goes to this agent, and text on screen could try to talk it into
        using those rights. An agent without them is safer.
      </p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          data-testid="helper-investigator-can-write-ack"
        />
        <span>{INVESTIGATOR_CAN_WRITE_ACK}</span>
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 font-medium disabled:opacity-50"
          disabled={!checked || busy}
          onClick={onConfirm}
          data-testid="helper-investigator-can-write-confirm"
        >
          {confirmLabel}
        </button>
        {onCancel ? (
          <button type="button" className="rounded-md px-2 py-1 text-muted-foreground" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

function withCurrent(choices: number[], current: number): number[] {
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
}

/**
 * Company settings → General → Helper: which saved model "Ask Paperclip"
 * answers with by default, the keys it may use, which full agent takes
 * "Investigate deeper" requests, and how many of those each person may run.
 * Everyone in the company can see this; only an owner or admin can change it.
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
  const [canWriteRefusal, setCanWriteRefusal] = useState<CanWriteRefusal | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: UpdateHelperSettings) => helperApi.updateSettings(companyId, patch),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.companies.helperSettings(companyId), next);
      setCanWriteRefusal(null);
      pushToast({ title: "Helper settings saved", tone: "success" });
    },
    onError: (error) => {
      // Picking an agent that can change things needs the confirmation box, not a toast.
      const refusal = canWriteRefusalOf(error);
      if (refusal) {
        setCanWriteRefusal(refusal);
        return;
      }
      pushToast({ title: error instanceof ApiError ? error.message : "Could not save the helper settings", tone: "error" });
    },
  });
  const investigator = settings?.investigationAgent ?? null;
  const groups = useMemo(() => groupEntries((settings?.models ?? []).map(toCatalogueItem), "maker"), [settings?.models]);
  const optionsById = useMemo(() => new Map((settings?.models ?? []).map((m) => [m.id, m])), [settings?.models]);

  return (
    <div className="space-y-4" data-testid="helper-settings">
      <div className="section-title">Helper (Ask Paperclip)</div>
      <div className="space-y-4 rounded-md section-box px-4 py-4 text-sm">
        <p className="text-xs text-muted-foreground">
          The “Ask” button at the bottom right of every page (or Ctrl/Cmd+Shift+H) opens a helper that explains what is
          on the page. You can mark part of the page and ask about it. It only reads the text you choose to send, it
          cannot change anything, and each answer is counted in Costs like any other model call. For harder questions
          it can hand over to an agent (see “Agent for deeper investigations” below).
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

            <div className="space-y-2" id="helper-investigations" data-testid="helper-investigation-settings">
              <label className="block space-y-1">
                <span className="text-xs font-medium">Agent for deeper investigations</span>
                <select
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm"
                  value={settings.investigationAgentId ?? ""}
                  disabled={readOnly || mutation.isPending}
                  onChange={(e) => mutation.mutate({ investigationAgentId: e.target.value || null })}
                  data-testid="helper-investigation-agent"
                >
                  <option value="">None — “Investigate deeper” is off</option>
                  {(agentsQuery.data ?? [])
                    .filter((agent) => agent.status !== "terminated" || agent.id === settings.investigationAgentId)
                    .map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                        {agent.status === "paused" ? " (paused)" : agent.status === "terminated" ? " (let go)" : ""}
                      </option>
                    ))}
                  {settings.investigationAgentId && !(agentsQuery.data ?? []).some((a) => a.id === settings.investigationAgentId) ? (
                    <option value={settings.investigationAgentId}>Saved agent</option>
                  ) : null}
                </select>
                <span className="block text-xs text-muted-foreground">
                  Some questions need real digging, like “Should I approve this?” on a deploy card, which means reading the
                  change, its reviews and its code. In the Ask panel people can press “Investigate deeper”: the question
                  goes to this agent as a normal task, and its answer comes back into the panel. It usually takes a few
                  minutes and is paid from this agent's budget; the panel shows the usual time and cost before anyone
                  starts one.
                </span>
                <span className="block text-xs text-muted-foreground">
                  The investigator can see everything in the company, and its answer goes to whoever asked. Only people
                  who may give this agent work can start an investigation, and records or pictures they cannot see are
                  left out.
                </span>
                <span className="block text-xs text-muted-foreground">
                  Recommended: a dedicated “Investigator” agent that can only read — no right to merge, deploy or change
                  settings, and no write access to code or servers. Paperclip tells the agent to give advice only and
                  never lets an agent approve or reject a card, but it cannot stop an agent that has write access from
                  changing things. An agent with such rights needs your confirmation first.
                </span>
              </label>
              {canWriteRefusal && !readOnly ? (
                <CanWriteConfirm
                  key={canWriteRefusal.agentId}
                  agentName={canWriteRefusal.agentName}
                  capabilities={canWriteRefusal.capabilities}
                  busy={mutation.isPending}
                  confirmLabel="Use this agent"
                  onConfirm={() =>
                    mutation.mutate({ investigationAgentId: canWriteRefusal.agentId, acknowledgeInvestigatorCanWrite: true })
                  }
                  onCancel={() => setCanWriteRefusal(null)}
                />
              ) : null}
              {!canWriteRefusal && investigator && investigator.writeCapabilities.length > 0 && !investigator.writeAcknowledged ? (
                readOnly ? (
                  <p className="text-xs text-amber-600" data-testid="helper-investigator-unconfirmed">
                    “{investigator.name}” can change things and no owner or admin has confirmed that, so investigations are
                    off until one does.
                  </p>
                ) : (
                  <CanWriteConfirm
                    key={`saved-${investigator.id}-${investigator.writeCapabilities.join("|")}`}
                    agentName={investigator.name}
                    capabilities={investigator.writeCapabilities}
                    busy={mutation.isPending}
                    confirmLabel="Confirm"
                    onConfirm={() => mutation.mutate({ acknowledgeInvestigatorCanWrite: true })}
                  />
                )
              ) : null}
              {investigator && investigator.writeCapabilities.length > 0 && investigator.writeAcknowledged ? (
                <p className="text-xs text-muted-foreground" data-testid="helper-investigator-confirmed">
                  Confirmed: “{investigator.name}” {investigator.writeCapabilities.join("; ")}.
                </p>
              ) : null}
              {investigator && investigator.budgetMonthlyCents === 0 && !readOnly ? (
                <p className="text-xs text-amber-600" data-testid="helper-investigator-no-budget">
                  “{investigator.name}” has no monthly budget, so only the limits below cap what investigations cost. You
                  can set a budget on the agent's page.
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Running at once, per person</span>
                  <select
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm"
                    value={settings.investigationMaxRunning}
                    disabled={readOnly || mutation.isPending}
                    onChange={(e) => mutation.mutate({ investigationMaxRunning: Number(e.target.value) })}
                    data-testid="helper-investigation-max-running"
                  >
                    {withCurrent(RUNNING_CHOICES, settings.investigationMaxRunning).map((n) => (
                      <option key={n} value={n}>
                        At most {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Started per person in 24 hours</span>
                  <select
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm"
                    value={settings.investigationMaxPerDay}
                    disabled={readOnly || mutation.isPending}
                    onChange={(e) => mutation.mutate({ investigationMaxPerDay: Number(e.target.value) })}
                    data-testid="helper-investigation-max-per-day"
                  >
                    {withCurrent(PER_DAY_CHOICES, settings.investigationMaxPerDay).map((n) => (
                      <option key={n} value={n}>
                        At most {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Whole company in 24 hours</span>
                  <select
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm"
                    value={settings.investigationCompanyMaxPerDay}
                    disabled={readOnly || mutation.isPending}
                    onChange={(e) => mutation.mutate({ investigationCompanyMaxPerDay: Number(e.target.value) })}
                    data-testid="helper-investigation-company-max-per-day"
                  >
                    {withCurrent(COMPANY_PER_DAY_CHOICES, settings.investigationCompanyMaxPerDay).map((n) => (
                      <option key={n} value={n}>
                        At most {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="block text-xs text-muted-foreground">
                Each investigation is a real agent run that costs money, so each person can only have a few running (stuck
                ones count until they are cancelled) and start a limited number per day, and the whole company has a daily
                ceiling too. Changing the limits does not stop anything already running.
              </span>
            </div>
            {readOnly ? (
              <p className="text-xs text-muted-foreground">Only a company owner or admin can change these settings.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

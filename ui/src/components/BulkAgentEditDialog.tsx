import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "../lib/agent-config-patch";
import { getThinkingEffortKey, getThinkingEffortOptions, supportsThinkingEffort } from "../lib/agent-model-effort";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BulkAgentEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  agentIds: string[];
}

const UNCHANGED_EFFORT = "__unchanged__";
// Radix Select forbids an empty-string item value, but "" (Auto) is a real,
// meaningful choice for effort — clears the adapter's override.
const AUTO_EFFORT = "__auto__";
const toSelectValue = (id: string) => id || AUTO_EFFORT;
const fromSelectValue = (value: string) => (value === AUTO_EFFORT ? "" : value);

/**
 * Apply Default Model / Backup (cheap) Model / Effort to several agents at once.
 * Each field is opt-in via its own checkbox so an untouched field never gets
 * silently blasted across every selected agent. Agents that can't take a given
 * field (no cheap-model profile support, or effort hidden for that adapter) are
 * skipped for that field, not failed. Reuses buildAgentUpdatePatch — the exact
 * read-modify-write merge PATCH /agents/:id already relies on — so a bulk apply
 * can never clobber unrelated adapterConfig/runtimeConfig on a target agent.
 */
export function BulkAgentEditDialog({ open, onOpenChange, companyId, agentIds }: BulkAgentEditDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const capabilities = useAdapterCapabilities();

  const [applyDefaultModel, setApplyDefaultModel] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");
  const [applyBackupModel, setApplyBackupModel] = useState(false);
  const [backupModel, setBackupModel] = useState("");
  const [applyEffort, setApplyEffort] = useState(false);
  const [effortValue, setEffortValue] = useState(UNCHANGED_EFFORT);
  const [effortText, setEffortText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });
  const agents = agentsQuery.data ?? [];
  const selectedAgents = useMemo(
    () => agents.filter((a) => agentIds.includes(a.id)),
    [agents, agentIds],
  );

  const backupIncapableCount = selectedAgents.filter(
    (a) => !capabilities(a.adapterType).supportsModelProfiles,
  ).length;
  const effortCapableAgents = selectedAgents.filter((a) => supportsThinkingEffort(a.adapterType));
  const effortIncapableCount = selectedAgents.length - effortCapableAgents.length;
  const uniformEffortOptions = useMemo(() => {
    if (effortCapableAgents.length === 0) return null;
    const signature = (a: (typeof effortCapableAgents)[number]) =>
      JSON.stringify(getThinkingEffortOptions(a.adapterType, a.adapterConfig));
    const first = signature(effortCapableAgents[0]);
    return effortCapableAgents.every((a) => signature(a) === first)
      ? getThinkingEffortOptions(effortCapableAgents[0].adapterType, effortCapableAgents[0].adapterConfig)
      : null;
  }, [effortCapableAgents]);

  function reset() {
    setApplyDefaultModel(false);
    setDefaultModel("");
    setApplyBackupModel(false);
    setBackupModel("");
    setApplyEffort(false);
    setEffortValue(UNCHANGED_EFFORT);
    setEffortText("");
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (agentIds.length === 0) throw new Error("No agents selected.");
      const resolvedEffort = uniformEffortOptions ? effortValue : effortText;
      const failures: string[] = [];
      const skippedBackupModel: string[] = [];
      const skippedEffort: string[] = [];
      let updatedCount = 0;

      for (const agentId of agentIds) {
        try {
          const agent = await agentsApi.get(agentId, companyId);
          const overlay: AgentConfigOverlay = { identity: {}, adapterConfig: {}, heartbeat: {}, runtime: {} };
          let touched = false;

          if (applyDefaultModel && defaultModel.trim()) {
            overlay.adapterConfig.model = defaultModel.trim();
            touched = true;
          }

          if (applyBackupModel && backupModel.trim()) {
            if (capabilities(agent.adapterType).supportsModelProfiles) {
              overlay.modelProfiles = {
                cheap: { adapterConfig: { model: backupModel.trim() }, enabled: true },
              };
              touched = true;
            } else {
              skippedBackupModel.push(agent.name);
            }
          }

          if (applyEffort && resolvedEffort !== UNCHANGED_EFFORT) {
            if (supportsThinkingEffort(agent.adapterType)) {
              const key = getThinkingEffortKey(agent.adapterType, agent.adapterConfig);
              overlay.adapterConfig[key] = resolvedEffort;
              touched = true;
            } else {
              skippedEffort.push(agent.name);
            }
          }

          if (touched) {
            const patch = buildAgentUpdatePatch(agent, overlay);
            await agentsApi.update(agentId, patch, companyId);
            updatedCount += 1;
          }
        } catch (e) {
          const name = selectedAgents.find((a) => a.id === agentId)?.name ?? agentId;
          failures.push(`${name}: ${e instanceof ApiError ? e.message : (e as Error).message}`);
        }
      }

      if (failures.length > 0) {
        throw new Error(
          `Updated ${updatedCount} agent(s), but failed for ${failures.length}: ${failures.join("; ")}`,
        );
      }
      return { updatedCount, skippedBackupModel, skippedEffort };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      const skippedNotes = [
        result.skippedBackupModel.length > 0
          ? `no backup-model support: ${result.skippedBackupModel.join(", ")}`
          : null,
        result.skippedEffort.length > 0
          ? `no effort setting: ${result.skippedEffort.join(", ")}`
          : null,
      ].filter((note): note is string => Boolean(note));
      pushToast({
        tone: skippedNotes.length > 0 ? "warn" : "success",
        title: `Updated ${result.updatedCount} agent${result.updatedCount === 1 ? "" : "s"}`,
        body: skippedNotes.length > 0 ? `Skipped for some agents — ${skippedNotes.join("; ")}.` : undefined,
      });
      reset();
      onOpenChange(false);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    },
  });

  const resolvedEffort = uniformEffortOptions ? effortValue : effortText;
  const hasAnyFieldToApply =
    (applyDefaultModel && defaultModel.trim().length > 0) ||
    (applyBackupModel && backupModel.trim().length > 0) ||
    (applyEffort && resolvedEffort !== UNCHANGED_EFFORT);
  const canSubmit = agentIds.length > 0 && hasAnyFieldToApply && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" /> Bulk edit {agentIds.length} agent{agentIds.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Only checked fields are applied. Agents that don't support a field are skipped for it, not failed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={applyDefaultModel}
                onCheckedChange={(value) => setApplyDefaultModel(Boolean(value))}
                id="bulk-apply-default-model"
              />
              <Label htmlFor="bulk-apply-default-model">Default model</Label>
            </div>
            <Input
              id="bulk-default-model"
              placeholder="e.g. claude-sonnet-5"
              value={defaultModel}
              disabled={!applyDefaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={applyBackupModel}
                onCheckedChange={(value) => setApplyBackupModel(Boolean(value))}
                id="bulk-apply-backup-model"
              />
              <Label htmlFor="bulk-apply-backup-model">Backup (fast) model</Label>
            </div>
            <Input
              id="bulk-backup-model"
              placeholder="e.g. claude-haiku-4-5"
              value={backupModel}
              disabled={!applyBackupModel}
              onChange={(e) => setBackupModel(e.target.value)}
            />
            {backupIncapableCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {backupIncapableCount} of {selectedAgents.length} selected agent
                {backupIncapableCount === 1 ? "" : "s"} don't support a backup model and will be skipped.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={applyEffort}
                onCheckedChange={(value) => setApplyEffort(Boolean(value))}
                id="bulk-apply-effort"
              />
              <Label htmlFor="bulk-apply-effort">Effort</Label>
            </div>
            {uniformEffortOptions ? (
              <Select
                value={toSelectValue(effortValue)}
                onValueChange={(v) => setEffortValue(fromSelectValue(v))}
                disabled={!applyEffort}
              >
                <SelectTrigger id="bulk-effort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNCHANGED_EFFORT}>Leave unchanged</SelectItem>
                  {uniformEffortOptions.map((option) => (
                    <SelectItem key={option.id || AUTO_EFFORT} value={toSelectValue(option.id)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <>
                <Input
                  id="bulk-effort"
                  placeholder="e.g. high (selected agents use different scales)"
                  value={effortText}
                  disabled={!applyEffort}
                  onChange={(e) => setEffortText(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Selected agents use different effort scales — enter a raw value valid for each (e.g. "high"),
                  or narrow your selection to agents on the same adapter.
                </p>
              </>
            )}
            {effortIncapableCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {effortIncapableCount} of {selectedAgents.length} selected agent
                {effortIncapableCount === 1 ? "" : "s"} don't expose an effort setting and will be skipped.
              </p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Apply to {agentIds.length} agent{agentIds.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

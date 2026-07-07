import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KNOWN_INTEGRATION_ENV_KEYS, getIntegrationKey } from "@paperclipai/shared";
import { KeyRound, Loader2 } from "lucide-react";
import { agentsApi } from "../api/agents";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
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

const CUSTOM_KEY = "__custom__";
const ALL_AGENTS = "__all__";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Derive a unique-ish, DB-safe secret key from the env key + a target slug. */
function secretKeyFor(envKey: string, targetSlug: string): string {
  return `${envKey}__${targetSlug}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

interface AddIntegrationTokenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

/**
 * Streamlined "add a tool token once, agents use it immediately" flow.
 * Pick a known env key (or custom), paste the value, choose who gets it (one
 * agent or all agents) — this creates the secret AND writes the env binding on
 * each target agent, so no manual adapterConfig editing is needed. Different
 * agents can hold different values for the same key (e.g. a write GITHUB_TOKEN
 * for a lead, read-only for others).
 */
export function AddIntegrationTokenDialog({
  open,
  onOpenChange,
  companyId,
}: AddIntegrationTokenDialogProps) {
  const queryClient = useQueryClient();
  const [keyChoice, setKeyChoice] = useState<string>(KNOWN_INTEGRATION_ENV_KEYS[0]?.key ?? CUSTOM_KEY);
  const [customKey, setCustomKey] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [targetAgentId, setTargetAgentId] = useState<string>(ALL_AGENTS);
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });
  const agents = agentsQuery.data ?? [];

  const envKey = keyChoice === CUSTOM_KEY ? customKey.trim() : keyChoice;
  const descriptor = getIntegrationKey(envKey);
  const envKeyValid = ENV_NAME_RE.test(envKey);

  const targetLabel = useMemo(() => {
    if (targetAgentId === ALL_AGENTS) return "all agents";
    return agents.find((a) => a.id === targetAgentId)?.name ?? "agent";
  }, [targetAgentId, agents]);

  const previewSecretName = envKey ? `${envKey} — ${targetLabel}` : "";

  function reset() {
    setKeyChoice(KNOWN_INTEGRATION_ENV_KEYS[0]?.key ?? CUSTOM_KEY);
    setCustomKey("");
    setValue("");
    setDescription("");
    setTargetAgentId(ALL_AGENTS);
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const targets =
        targetAgentId === ALL_AGENTS ? agents.map((a) => a.id) : [targetAgentId];
      if (targets.length === 0) throw new Error("No agents to bind this token to.");

      // 1. Create the secret (value never leaves this request).
      const secret = await secretsApi.create(companyId, {
        name: previewSecretName,
        key: secretKeyFor(envKey, targetLabel),
        provider: "local_encrypted",
        value,
        description: description.trim() || descriptor?.description || null,
      });

      // 2. Bind it into each target agent's env via read-modify-write so we
      //    never clobber existing bindings (e.g. CLAUDE_CODE_OAUTH_TOKEN).
      const ref = { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const };
      const failures: string[] = [];
      for (const agentId of targets) {
        try {
          const detail = await agentsApi.get(agentId, companyId);
          const cfg = { ...((detail.adapterConfig ?? {}) as Record<string, unknown>) };
          const env = { ...((cfg.env as Record<string, unknown>) ?? {}) };
          env[envKey] = ref;
          cfg.env = env;
          await agentsApi.update(agentId, { adapterConfig: cfg }, companyId);
        } catch (e) {
          const name = agents.find((a) => a.id === agentId)?.name ?? agentId;
          failures.push(`${name}: ${e instanceof ApiError ? e.message : (e as Error).message}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `Secret created, but binding failed for ${failures.length} agent(s): ${failures.join("; ")}`,
        );
      }
      return { boundCount: targets.length };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      reset();
      onOpenChange(false);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    },
  });

  const canSubmit = envKeyValid && value.length > 0 && !mutation.isPending;

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
            <KeyRound className="h-4 w-4" /> Add integration token
          </DialogTitle>
          <DialogDescription>
            Store a tool token once and bind it to your agents in one step — no manual config.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="int-key">Token / environment variable</Label>
            <Select value={keyChoice} onValueChange={setKeyChoice}>
              <SelectTrigger id="int-key">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KNOWN_INTEGRATION_ENV_KEYS.map((entry) => (
                  <SelectItem key={entry.key} value={entry.key}>
                    {entry.label} ({entry.key})
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_KEY}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            {keyChoice === CUSTOM_KEY && (
              <Input
                className="mt-2 font-mono"
                placeholder="MY_CUSTOM_TOKEN"
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
              />
            )}
            {descriptor && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-0.5">
                {descriptor.gitPush && (
                  <Badge variant="secondary" className="text-[10px] px-1 py-0">
                    git push
                  </Badge>
                )}
                {descriptor.description}
              </p>
            )}
            {keyChoice === CUSTOM_KEY && customKey.length > 0 && !envKeyValid && (
              <p className="text-xs text-destructive">
                Must start with a letter or underscore and contain only A–Z, 0–9, _.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="int-value">Token value</Label>
            <Input
              id="int-value"
              type="password"
              autoComplete="off"
              placeholder="Paste the token"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="int-target">Give it to</Label>
            <Select value={targetAgentId} onValueChange={setTargetAgentId}>
              <SelectTrigger id="int-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_AGENTS}>
                  All agents{agents.length ? ` (${agents.length})` : ""}
                </SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.role ? ` · ${agent.role}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Same key, different value per agent — e.g. a write token for a lead, read-only for the rest.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="int-desc">Note (optional)</Label>
            <Textarea
              id="int-desc"
              rows={2}
              placeholder="What this token is for"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {envKey && envKeyValid && (
            <p className="text-xs text-muted-foreground">
              Saves as secret <span className="font-mono">{previewSecretName}</span> and binds{" "}
              <span className="font-mono">{envKey}</span> on {targetLabel}.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Add & bind
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

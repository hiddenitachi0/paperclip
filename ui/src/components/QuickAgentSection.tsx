import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LANE_A_INSTRUCTIONS_MAX_LENGTH } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/**
 * Quick agent settings: the on/off switch plus the instruction set the quick
 * agent follows. Both are board-only on the server (the API refuses anyone
 * else), so this card is only ever useful to the operator.
 */
export function QuickAgentSection({
  agent,
  companyId,
}: {
  agent: { id: string; urlKey: string; companyId: string; name: string; laneAEnabled?: boolean; laneAInstructions?: string | null };
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const savedEnabled = Boolean(agent.laneAEnabled);
  const savedInstructions = agent.laneAInstructions ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [savedInstructions]);

  const instructions = draft ?? savedInstructions;
  const dirty = draft !== null && draft !== savedInstructions;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agent.companyId) });
  };

  const toggleMutation = useMutation({
    mutationFn: (laneAEnabled: boolean) => agentsApi.update(agent.id, { laneAEnabled }, companyId),
    onSuccess: (_result, laneAEnabled) => {
      invalidate();
      pushToast({
        title: laneAEnabled ? `${agent.name} is now a quick agent` : `${agent.name} is no longer a quick agent`,
        tone: "success",
      });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not change the quick agent switch");
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      agentsApi.update(agent.id, { laneAInstructions: instructions.trim() ? instructions : null }, companyId),
    onSuccess: () => {
      setDraft(null);
      setError(null);
      invalidate();
      pushToast({ title: "Quick agent instructions saved", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not save the instructions");
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Quick agent</CardTitle>
            <CardDescription>
              A quick agent answers you directly in chat instead of running as a full agent. It remembers the
              conversation and can do three things: hand work to a colleague, look up the weather, and read a task
              summary. Good for a secretary or a weather helper. Only you can switch this on.
            </CardDescription>
          </div>
          <ToggleSwitch
            checked={savedEnabled}
            onCheckedChange={(next) => toggleMutation.mutate(next)}
            disabled={toggleMutation.isPending}
            aria-label="Quick agent on or off"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Instructions</p>
          <p className="text-xs text-muted-foreground">
            Tell the quick agent who it is and what to do, in plain words. Example: "You are the front desk. Anything
            about invoices goes to Finn. Anything technical goes to Bob. Answer in Norwegian."
          </p>
        </div>
        <Textarea
          value={instructions}
          onChange={(event) => setDraft(event.target.value)}
          rows={8}
          maxLength={LANE_A_INSTRUCTIONS_MAX_LENGTH}
          placeholder="You are the front desk for this company. Route requests to the right colleague and keep answers short."
          className="text-sm"
          disabled={!savedEnabled && !dirty && !instructions}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {instructions.length} / {LANE_A_INSTRUCTIONS_MAX_LENGTH}
            {!savedEnabled && " · switch the quick agent on to start chatting"}
          </p>
          <div className="flex items-center gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(null); }}>
                Cancel
              </Button>
            )}
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : "Save instructions"}
            </Button>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { extractSorteringsreglerBlock, withSorteringsreglerBlock } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

/**
 * DUR-68: Filip never edits the rest of AGENTS.md — this box reads and
 * writes only the fenced SORTERINGSREGLER block, one line per rule, each
 * ending in the name of the agent it routes to (after the line's last
 * colon). The server re-validates every name against live agents on save
 * regardless of what this box does client-side.
 */
export function SorteringsreglerCard({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: bundle } = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agentId),
    queryFn: () => agentsApi.instructionsBundle(agentId, companyId),
    enabled: Boolean(companyId),
  });
  const entryFile = bundle?.entryFile ?? "AGENTS.md";

  // Shares AgentDetail's PromptsTab query key for this same file/agent pair,
  // so a save from either editor invalidates and refetches the other's copy
  // instead of the two silently overwriting each other's in-flight edits.
  const { data: fileDetail, isLoading } = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agentId, entryFile),
    queryFn: () => agentsApi.instructionsFile(agentId, entryFile, companyId),
    enabled: Boolean(companyId && bundle),
  });

  const extractedBlock = fileDetail ? extractSorteringsreglerBlock(fileDetail.content) : null;
  const blockExists = fileDetail ? extractedBlock !== null : null;
  const savedRules = fileDetail ? (extractedBlock ?? "") : null;

  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [savedRules]);

  const rules = draft ?? savedRules ?? "";
  const dirty = draft !== null && draft !== (savedRules ?? "");

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!fileDetail) throw new Error("Rules not loaded yet");
      const nextContent = withSorteringsreglerBlock(fileDetail.content, rules);
      return agentsApi.saveInstructionsFile(agentId, { path: entryFile, content: nextContent }, companyId);
    },
    onSuccess: () => {
      setDraft(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agentId, entryFile) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agentId) });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not save the rules");
    },
  });

  // Only the secretary's AGENTS.md has this block (DUR-68): once loaded,
  // stay hidden on every other agent's page instead of cluttering it with
  // an irrelevant "add sorting rules" card. Hooks above must still run
  // unconditionally on every render, so this check comes after all of them.
  if (blockExists === false) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sorting rules — who gets what</CardTitle>
        <CardDescription>
          One rule per line, ending with the name of the agent the rule sends to (after the last colon).
          Finish with a catch-all line so there is always a default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={isLoading ? "" : rules}
          onChange={(event) => setDraft(event.target.value)}
          disabled={isLoading}
          rows={8}
          placeholder={"Table damaged on delivery: Claims Rep\nCan you send a quote for chairs?: Sales Rep\nOtherwise: Claims Rep"}
          className="font-mono text-sm"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(null); }}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving…" : "Save rules"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

const START_MARKER = "<!-- SORTERINGSREGLER -->";
const END_MARKER = "<!-- /SORTERINGSREGLER -->";

function extractRulesBlock(content: string): string | null {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  return content.slice(startIdx + START_MARKER.length, endIdx).trim();
}

function withRulesBlock(content: string, rules: string): string {
  const block = `${START_MARKER}\n${rules.trim()}\n${END_MARKER}`;
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return content.slice(0, startIdx) + block + content.slice(endIdx + END_MARKER.length);
  }
  const separator = content.trim().length > 0 ? "\n\n" : "";
  return `${content}${separator}${block}\n`;
}

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

  const blockExists = fileDetail ? extractRulesBlock(fileDetail.content) !== null : null;
  const savedRules = fileDetail ? (extractRulesBlock(fileDetail.content) ?? "") : null;

  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [savedRules]);

  const rules = draft ?? savedRules ?? "";
  const dirty = draft !== null && draft !== (savedRules ?? "");

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!fileDetail) throw new Error("Rules not loaded yet");
      const nextContent = withRulesBlock(fileDetail.content, rules);
      return agentsApi.saveInstructionsFile(agentId, { path: entryFile, content: nextContent }, companyId);
    },
    onSuccess: () => {
      setDraft(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsFile(agentId, entryFile) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.instructionsBundle(agentId) });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Kunne ikke lagre reglene");
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
        <CardTitle>Sorteringsregler — hvem får hva</CardTitle>
        <CardDescription>
          Én regel per linje, avsluttet med navnet på agenten regelen sender til (etter siste kolon).
          Avslutt med en catch-all-linje så det alltid finnes et standardvalg.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={isLoading ? "" : rules}
          onChange={(event) => setDraft(event.target.value)}
          disabled={isLoading}
          rows={8}
          placeholder={"Skadet bord ved levering: Claims Rep\nKan dere sende tilbud på stoler?: Sales Rep\nEllers: Claims Rep"}
          className="font-mono text-sm"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(null); }}>
              Avbryt
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? "Lagrer…" : "Lagre regler"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

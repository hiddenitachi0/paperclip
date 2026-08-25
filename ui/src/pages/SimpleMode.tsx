import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import {
  buildSimpleModeIssuePayload,
  findLatestSimpleModeReply,
  isSimpleModeSettled,
  sanitizeSimpleModeText,
  selectSimpleModeAssignee,
} from "../lib/simple-mode";
import { cn } from "../lib/utils";

/**
 * Simple mode (DUR-212) — the front door for people who have never seen
 * Paperclip and never should have to. A blank page, a text box. Submitting
 * creates a completely normal Paperclip issue with a normal assignee; the
 * person just never sees the board, the ticket id, or an approval card
 * unless they click through to "View details".
 */

const POLL_INTERVAL_MS = 3000;

function notifyDone(title: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification("Paperclip", { body: title });
  }
}

export function SimpleMode() {
  const navigate = useNavigate();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const { companies, loading: companiesLoading, setSelectedCompanyId } = useCompany();

  const targetCompany = useMemo(
    () =>
      companyPrefix
        ? companies.find((c) => c.issuePrefix.toUpperCase() === companyPrefix.toUpperCase()) ?? null
        : null,
    [companies, companyPrefix],
  );

  useEffect(() => {
    if (targetCompany) setSelectedCompanyId(targetCompany.id, { source: "route_sync" });
  }, [targetCompany, setSelectedCompanyId]);

  const companyId = targetCompany?.id ?? null;

  const [input, setInput] = useState("");
  const [issueId, setIssueId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const notifiedRef = useRef(false);
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId ?? ""),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId,
    refetchInterval: (query) => {
      const current = query.state.data;
      if (!current || !isSimpleModeSettled(current.status)) return POLL_INTERVAL_MS;
      return false;
    },
  });

  const settled = issue ? isSimpleModeSettled(issue.status) : false;

  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(issueId ?? ""),
    queryFn: () => issuesApi.listComments(issueId!, { order: "desc", limit: 20 }),
    enabled: !!issueId && settled,
  });

  const reply = useMemo(() => findLatestSimpleModeReply(comments), [comments]);

  useEffect(() => {
    if (settled && !notifiedRef.current) {
      notifiedRef.current = true;
      notifyDone("Your request is done — come take a look.");
    }
  }, [settled]);

  if (!companiesLoading && companyPrefix && !targetCompany) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit() {
    const text = input.trim();
    if (!text || !companyId) return;
    setError(null);
    setSubmitting(true);
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    try {
      const assignee = selectSimpleModeAssignee(agents);
      if (!assignee) {
        setError("Nobody is set up to take this yet. Try again in a moment.");
        return;
      }
      const created = await issuesApi.create(
        companyId,
        buildSimpleModeIssuePayload({ text, assigneeAgentId: assignee.id }),
      );
      notifiedRef.current = false;
      setIssueId(created.id);
      setInput("");
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleAskSomethingElse() {
    setIssueId(null);
    setError(null);
  }

  const working = !!issueId && !settled;

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4">
      <div className="w-full max-w-xl">
        {!issueId ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <Textarea
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder="What do you need?"
              rows={4}
              className="resize-none text-base"
              disabled={submitting}
            />
            <Button type="submit" disabled={submitting || !input.trim()} size="lg">
              {submitting ? "Starting…" : "Go"}
            </Button>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            {working ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span
                  className={cn(
                    "h-2 w-2 animate-pulse rounded-full bg-primary",
                  )}
                  aria-hidden
                />
                I'm working on this…
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="whitespace-pre-wrap text-base text-foreground">
                  {reply ? sanitizeSimpleModeText(reply.body) : "Done."}
                </p>
                {issue?.identifier ? (
                  <button
                    type="button"
                    className="self-start text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                    onClick={() => navigate(`/${companyPrefix}/issues/${issue.identifier}`)}
                  >
                    View details
                  </button>
                ) : null}
              </div>
            )}
            <Button variant="outline" onClick={handleAskSomethingElse} disabled={working}>
              Ask something else
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

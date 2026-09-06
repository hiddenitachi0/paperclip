import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { chatApi, type ChatClassification } from "../api/chat";
import { queryKeys } from "../lib/queryKeys";
import {
  findLatestSimpleModeReply,
  isSimpleModeSettled,
  sanitizeSimpleModeText,
  selectSimpleModeAssignee,
  UNAVAILABLE_AGENT_STATUSES,
} from "../lib/simple-mode";
import { cn } from "../lib/utils";

/**
 * Simple mode (DUR-212) — the front door for people who have never seen
 * Paperclip and never should have to. A blank page, a text box. Submitting
 * sends the message through the chat router (DUR-220); a secretary
 * classifier (DUR-335) picks who should see it and whether it is a quick
 * question or real work, and the person can correct either pick before
 * sending. The reply either comes back immediately (a quick question) or the
 * page watches a normal Paperclip issue behind the scenes (real work) — the
 * person just never sees the board, the ticket id, or an approval card
 * unless they click through to "View details".
 */

const POLL_INTERVAL_MS = 3000;
const CLASSIFY_DEBOUNCE_MS = 600;
const CLASSIFY_MIN_LENGTH = 6;

const LANE_LABELS: Record<"a" | "b", string> = {
  a: "Quick question",
  b: "Real work",
};

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
  const [laneAReply, setLaneAReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const notifiedRef = useRef(false);
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  // Secretary classifier (DUR-335): who this should go to and whether it's a
  // quick question or real work. The user can override either pick
  // independently; an untouched field defaults to the classifier's pick.
  // If the call errors, classification stays null and send falls back
  // silently to selectSimpleModeAssignee's last-resort default.
  const [classification, setClassification] = useState<ChatClassification | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [laneOverride, setLaneOverride] = useState<"a" | "b" | null>(null);
  const [recipientOverride, setRecipientOverride] = useState<string | null>(null);
  const classifyRequestRef = useRef(0);

  useEffect(() => {
    const text = input.trim();
    if (!text || !companyId || text.length < CLASSIFY_MIN_LENGTH) {
      setClassification(null);
      setClassifying(false);
      return;
    }
    const requestId = ++classifyRequestRef.current;
    setClassifying(true);
    const timer = setTimeout(() => {
      chatApi
        .classify(companyId, text)
        .then((result) => {
          if (classifyRequestRef.current !== requestId) return;
          setClassification(result);
        })
        .catch(() => {
          if (classifyRequestRef.current !== requestId) return;
          setClassification(null);
        })
        .finally(() => {
          if (classifyRequestRef.current !== requestId) return;
          setClassifying(false);
        });
    }, CLASSIFY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, companyId]);

  const availableAgents = useMemo(
    () => (agents ?? []).filter((a) => !UNAVAILABLE_AGENT_STATUSES.has(a.status)),
    [agents],
  );

  const resolvedLane = laneOverride ?? classification?.lane ?? null;
  const resolvedAgentId = recipientOverride ?? classification?.targetAgentId ?? null;
  const resolvedAgent = availableAgents.find((a) => a.id === resolvedAgentId) ?? null;
  const showPreview = !!input.trim() && !!(classification || recipientOverride || laneOverride);

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
      let agentId = recipientOverride ?? classification?.targetAgentId ?? null;
      let laneHint = laneOverride ?? classification?.lane ?? undefined;
      if (!agentId) {
        const assignee = selectSimpleModeAssignee(agents);
        if (!assignee) {
          setError("Nobody is set up to take this yet. Try again in a moment.");
          return;
        }
        agentId = assignee.id;
        laneHint = undefined;
      }
      const response = await chatApi.sendMessage(agentId, { companyId, message: text, laneHint });
      notifiedRef.current = false;
      setInput("");
      setClassification(null);
      setLaneOverride(null);
      setRecipientOverride(null);
      if (response.lane === "a") {
        setLaneAReply(response.result?.response ?? "Done.");
        setIssueId(null);
      } else {
        setLaneAReply(null);
        setIssueId(response.taskRef!.issueId);
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleAskSomethingElse() {
    setIssueId(null);
    setLaneAReply(null);
    setError(null);
  }

  const responded = !!issueId || laneAReply !== null;
  const working = !!issueId && !settled;

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4">
      <div className="w-full max-w-xl">
        {!responded ? (
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
            {showPreview ? (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Sending to</span>
                  <Select value={resolvedAgentId ?? undefined} onValueChange={setRecipientOverride}>
                    <SelectTrigger size="sm" className="h-7 w-auto">
                      <SelectValue placeholder="Choose someone">{resolvedAgent?.name}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {availableAgents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground">as</span>
                  <div className="flex gap-1">
                    {(["a", "b"] as const).map((lane) => (
                      <button
                        key={lane}
                        type="button"
                        onClick={() => setLaneOverride(lane)}
                        className={cn(
                          "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                          resolvedLane === lane
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {LANE_LABELS[lane]}
                      </button>
                    ))}
                  </div>
                </div>
                {classification?.reasoning ? (
                  <p className="text-xs text-muted-foreground">{classification.reasoning}</p>
                ) : null}
              </div>
            ) : classifying ? (
              <p className="text-xs text-muted-foreground">Figuring out who should see this…</p>
            ) : null}
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
                  {laneAReply ?? (reply ? sanitizeSimpleModeText(reply.body) : "Done.")}
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

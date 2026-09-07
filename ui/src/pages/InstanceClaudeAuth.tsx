import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstanceClaudeAuthStatus, InstanceClaudeSignInSession } from "@paperclipai/shared";
import { CLAUDE_OAUTH_TOKEN_PATTERN } from "@paperclipai/shared";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { instanceClaudeAuthApi } from "@/api/instanceClaudeAuth";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

const SIGN_IN_POLL_MS = 2000;

function isLiveSignIn(session: InstanceClaudeSignInSession | null | undefined): boolean {
  return !!session && (session.status === "starting" || session.status === "awaiting_code" || session.status === "exchanging");
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function healthBadge(status: InstanceClaudeAuthStatus) {
  switch (status.health) {
    case "ok":
      return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Signed in</Badge>;
    case "unverified":
      return <Badge variant="secondary">Signed in, not tested</Badge>;
    case "expiring_soon":
      return <Badge className="bg-amber-500 text-white hover:bg-amber-500">Expiring soon</Badge>;
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    case "check_failed":
      return <Badge variant="destructive">Needs attention</Badge>;
    default:
      return <Badge variant="outline">Not signed in</Badge>;
  }
}

export function InstanceClaudeAuth() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [actionError, setActionError] = useState<string | null>(null);
  const [signInId, setSignInId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pastedToken, setPastedToken] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings" },
      { label: "Claude sign-in" },
    ]);
  }, [setBreadcrumbs]);

  const statusQuery = useQuery({
    queryKey: queryKeys.instance.claudeAuth,
    queryFn: () => instanceClaudeAuthApi.get(),
  });
  const status = statusQuery.data ?? null;

  // A sign-in started before a page reload is still running on the server;
  // pick it up instead of leaving the operator staring at a dead button.
  const activeSignIn = status?.activeSignIn ?? null;
  useEffect(() => {
    if (!signInId && activeSignIn && isLiveSignIn(activeSignIn)) {
      setSignInId(activeSignIn.id);
    }
  }, [signInId, activeSignIn]);

  const signInQuery = useQuery({
    queryKey: signInId ? queryKeys.instance.claudeSignIn(signInId) : ["instance", "claude-auth", "sign-in", "none"],
    queryFn: () => instanceClaudeAuthApi.getSignIn(signInId as string),
    enabled: !!signInId,
    refetchInterval: (query) => (isLiveSignIn(query.state.data) ? SIGN_IN_POLL_MS : false),
    retry: false,
  });
  const signIn = signInId ? signInQuery.data ?? null : null;

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: queryKeys.instance.claudeAuth });

  // When the interactive sign-in finishes, refresh the status card and say so.
  const signInStatus = signIn?.status;
  useEffect(() => {
    if (signInStatus === "completed") {
      void invalidateStatus();
      pushToast({ tone: "success", title: "Signed in to Claude", body: "Every Claude agent will use this sign-in from its next run." });
      setSignInId(null);
      setCode("");
    }
    // Only the transition into "completed" matters here; the other values
    // this reads are stable callbacks.
  }, [signInStatus]);

  const startSignIn = useMutation({
    mutationFn: () => instanceClaudeAuthApi.startSignIn(),
    onSuccess: (session) => {
      setActionError(null);
      setCode("");
      setSignInId(session.id);
      queryClient.setQueryData(queryKeys.instance.claudeSignIn(session.id), session);
    },
    onError: (error) => setActionError(errorMessage(error, "Could not start the Claude sign-in.")),
  });

  const submitCode = useMutation({
    mutationFn: () => instanceClaudeAuthApi.submitSignInCode(signInId as string, code.trim()),
    onSuccess: (session) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.claudeSignIn(session.id), session);
    },
    onError: (error) => setActionError(errorMessage(error, "Claude did not accept that code.")),
  });

  const cancelSignIn = useMutation({
    mutationFn: () => instanceClaudeAuthApi.cancelSignIn(signInId as string),
    onSettled: () => {
      setSignInId(null);
      setCode("");
      void invalidateStatus();
    },
  });

  const saveToken = useMutation({
    mutationFn: () => instanceClaudeAuthApi.saveToken(pastedToken.trim()),
    onSuccess: () => {
      setActionError(null);
      setPastedToken("");
      setShowPaste(false);
      void invalidateStatus();
      pushToast({ tone: "success", title: "Token saved", body: "Claude accepted it. Every Claude agent will use it from its next run." });
    },
    onError: (error) => setActionError(errorMessage(error, "Could not save the token.")),
  });

  const checkNow = useMutation({
    mutationFn: () => instanceClaudeAuthApi.check(),
    onSuccess: (next) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.claudeAuth, next);
      pushToast({
        tone: next.lastCheckOk ? "success" : "warn",
        title: next.lastCheckOk ? "Claude sign-in works" : "Claude rejected the sign-in",
        body: next.lastCheckMessage ?? undefined,
      });
    },
    onError: (error) => setActionError(errorMessage(error, "Could not check the sign-in.")),
  });

  const remove = useMutation({
    mutationFn: () => instanceClaudeAuthApi.remove(),
    onSuccess: (next) => {
      setActionError(null);
      setConfirmRemove(false);
      queryClient.setQueryData(queryKeys.instance.claudeAuth, next);
      pushToast({ tone: "warn", title: "Claude sign-in removed", body: "Claude agents without their own token will stop until you sign in again." });
    },
    onError: (error) => setActionError(errorMessage(error, "Could not remove the sign-in.")),
  });

  const pastedTokenLooksRight = useMemo(() => CLAUDE_OAUTH_TOKEN_PATTERN.test(pastedToken.trim()), [pastedToken]);
  const busy = startSignIn.isPending || submitCode.isPending || saveToken.isPending || checkNow.isPending || remove.isPending;

  if (statusQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading Claude sign-in…</div>;
  }
  if (statusQuery.error || !status) {
    return (
      <div className="text-sm text-destructive">
        {errorMessage(statusQuery.error, "Could not load the Claude sign-in status.")}
      </div>
    );
  }

  const liveSignIn = isLiveSignIn(signIn) ? signIn : null;
  const finishedSignIn = signIn && !isLiveSignIn(signIn) && signIn.status !== "completed" ? signIn : null;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Claude sign-in</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Sign in once with your Claude subscription and every Claude agent on this server uses it — no
          per-agent token to create or bind. Agents that already have their own token keep using theirs.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Status</h2>
              {healthBadge(status)}
            </div>
            {status.configured && (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => checkNow.mutate()}>
                  {checkNow.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  Check now
                </Button>
                {confirmRemove ? (
                  <>
                    <Button variant="destructive" size="sm" disabled={busy} onClick={() => remove.mutate()}>
                      {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      Yes, remove it
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(false)}>
                      Keep it
                    </Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
                    <Trash2 className="size-4" />
                    Remove sign-in
                  </Button>
                )}
              </div>
            )}
          </div>
          <p className="text-sm">{status.headline}</p>
          {status.configured && (
            <div className="grid gap-3 md:grid-cols-4">
              <StatusBox
                label="Signed in"
                value={formatDate(status.savedAt)}
                hint={status.source === "signin" ? "via the sign-in link" : "pasted token"}
              />
              <StatusBox
                label="Expires"
                value={status.expiresAt ? `about ${formatDate(status.expiresAt)}` : "unknown"}
                hint={
                  status.expiresInDays != null
                    ? status.expiresInDays > 0
                      ? `in about ${status.expiresInDays} days (Claude tokens last one year)`
                      : "already passed"
                    : undefined
                }
              />
              <StatusBox
                label="Last checked"
                value={formatDateTime(status.lastCheckAt)}
                hint={status.lastCheckMessage ?? undefined}
              />
              <StatusBox
                label="Last used by an agent"
                value={formatDateTime(status.lastUsedAt)}
                hint={status.lastAuthFailureAt ? `Claude asked an agent to log in on ${formatDateTime(status.lastAuthFailureAt)}` : undefined}
              />
            </div>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{status.configured ? "Sign in again" : "Sign in with Claude"}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Three steps: click the button, approve Paperclip on the Claude page that opens, then paste the
              code Claude shows you back here. The token is tested with Claude and stored encrypted on this
              server; it is never shown again.
            </p>
          </div>

          {!status.automaticSignIn.supported && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
              <span>{status.automaticSignIn.reason ?? "Automatic sign-in is not available on this server."}</span>
            </div>
          )}

          {!liveSignIn && status.automaticSignIn.supported && (
            <Button disabled={busy} onClick={() => startSignIn.mutate()}>
              {startSignIn.isPending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              {status.configured ? "Sign in again" : "Sign in with Claude"}
            </Button>
          )}

          {liveSignIn && (
            <div className="space-y-4 rounded-lg border border-border bg-background p-4">
              <Step
                number={1}
                title="Open the Claude sign-in page"
                done={liveSignIn.status !== "starting"}
              >
                {liveSignIn.status === "starting" ? (
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Getting your sign-in link from Claude…
                  </span>
                ) : liveSignIn.loginUrl ? (
                  <a
                    href={liveSignIn.loginUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
                  >
                    <ExternalLink className="size-4" /> Open Claude and approve Paperclip
                  </a>
                ) : null}
              </Step>
              <Step
                number={2}
                title="Paste the code Claude shows you"
                done={liveSignIn.status === "exchanging"}
              >
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (code.trim()) submitCode.mutate();
                  }}
                >
                  <Input
                    className="w-full max-w-md font-mono"
                    placeholder="Paste the code here"
                    autoComplete="off"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    disabled={liveSignIn.status !== "awaiting_code" || submitCode.isPending}
                    aria-label="Code from Claude"
                  />
                  <Button type="submit" size="sm" disabled={liveSignIn.status !== "awaiting_code" || !code.trim() || submitCode.isPending}>
                    {submitCode.isPending || liveSignIn.status === "exchanging" ? <Loader2 className="size-4 animate-spin" /> : null}
                    Finish sign-in
                  </Button>
                </form>
              </Step>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{liveSignIn.message}</p>
                <Button variant="ghost" size="sm" disabled={cancelSignIn.isPending} onClick={() => cancelSignIn.mutate()}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {finishedSignIn && (
            <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              <span>{finishedSignIn.message ?? "The sign-in did not finish."}</span>
              <Button variant="ghost" size="sm" onClick={() => { setSignInId(null); setCode(""); }}>
                Dismiss
              </Button>
            </div>
          )}

          <div className="border-t border-border pt-4">
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => setShowPaste((value) => !value)}
            >
              {showPaste ? "Hide the paste option" : "Already have a token? Paste it instead"}
            </button>
            {showPaste && (
              <div className="mt-3 space-y-3">
                <p className="max-w-2xl text-sm text-muted-foreground">
                  On any computer where you use Claude Code, open a terminal and run{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">claude setup-token</code>. Sign in when
                  the browser opens, then copy the long line that starts with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">sk-ant-oat01-</code> and paste it
                  below. It is tested with Claude before it is saved.
                </p>
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (pastedTokenLooksRight) saveToken.mutate();
                  }}
                >
                  <Label htmlFor="claude-token">Claude subscription token</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="claude-token"
                      type="password"
                      autoComplete="off"
                      className="w-full max-w-md font-mono"
                      placeholder="sk-ant-oat01-…"
                      value={pastedToken}
                      onChange={(event) => setPastedToken(event.target.value)}
                      disabled={saveToken.isPending}
                      aria-invalid={pastedToken.length > 0 && !pastedTokenLooksRight}
                    />
                    <Button type="submit" size="sm" disabled={!pastedTokenLooksRight || busy}>
                      {saveToken.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                      Test and save
                    </Button>
                  </div>
                  {pastedToken.length > 0 && !pastedTokenLooksRight && (
                    <p className="text-xs text-destructive">
                      That does not look right yet: it should start with sk-ant-oat01- and be one long line with no spaces.
                    </p>
                  )}
                </form>
              </div>
            )}
          </div>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Claude CLI on this server: {status.cli.version ?? `not found (command "${status.cli.command}")`}.
        {" "}The sign-in is stored encrypted with the same key as your other secrets and never appears in logs or on
        this page.
      </p>
    </div>
  );
}

function Step({ number, title, done, children }: { number: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={
          done
            ? "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white"
            : "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold"
        }
      >
        {done ? "✓" : number}
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">{title}</div>
        {children}
      </div>
    </div>
  );
}

function StatusBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

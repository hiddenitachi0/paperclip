/**
 * DUR-3995: "Paperclip's own Claude key".
 *
 * Paperclip does a few things itself, without starting an agent: answering a
 * quick question, working out who a request should go to, and checking a
 * finished task before it is marked done. Those need a Claude API key that
 * belongs to Paperclip, not to an agent. Until now the only way to set one
 * was to edit a file on the server and restart it.
 *
 * The key is never shown again after it is saved -- this card shows at most
 * its last four characters, when it was saved, and what Claude said the last
 * time it was tested.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ANTHROPIC_API_KEY_PATTERN } from "@paperclipai/shared";
import { CheckCircle2, Loader2, RefreshCw, Trash2, Wrench } from "lucide-react";
import { instanceServerAnthropicKeyApi } from "@/api/instanceServerAnthropicKey";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

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

export function ServerClaudeKeyCard() {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [pastedKey, setPastedKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.instance.serverAnthropicKey,
    queryFn: () => instanceServerAnthropicKeyApi.get(),
    retry: false,
  });
  const status = statusQuery.data ?? null;

  const save = useMutation({
    mutationFn: () => instanceServerAnthropicKeyApi.save(pastedKey.trim()),
    onSuccess: (result) => {
      setActionError(null);
      setPastedKey("");
      queryClient.setQueryData(queryKeys.instance.serverAnthropicKey, result.status);
      pushToast({
        tone: result.ok ? "success" : "warn",
        title: result.ok ? "Key saved" : "Key saved, but Claude did not accept it",
        body: result.message,
      });
    },
    onError: (error) => setActionError(errorMessage(error, "Could not save the key.")),
  });

  const test = useMutation({
    mutationFn: () => instanceServerAnthropicKeyApi.test(),
    onSuccess: (result) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.serverAnthropicKey, result.status);
      pushToast({
        tone: result.ok ? "success" : "warn",
        title: result.ok ? "The key works" : "Claude did not accept the key",
        body: result.message,
      });
    },
    onError: (error) => setActionError(errorMessage(error, "Could not test the key.")),
  });

  const remove = useMutation({
    mutationFn: () => instanceServerAnthropicKeyApi.remove(),
    onSuccess: (next) => {
      setActionError(null);
      setConfirmRemove(false);
      queryClient.setQueryData(queryKeys.instance.serverAnthropicKey, next);
      pushToast({
        tone: "warn",
        title: "Key removed",
        body: "Quick answers, routing and the quality check stop working until you add a key again.",
      });
    },
    onError: (error) => setActionError(errorMessage(error, "Could not remove the key.")),
  });

  const keyLooksRight = useMemo(() => ANTHROPIC_API_KEY_PATTERN.test(pastedKey.trim()), [pastedKey]);
  const busy = save.isPending || test.isPending || remove.isPending;

  // Only instance admins may read this; for anyone else the card simply is
  // not part of their settings page.
  if (statusQuery.error instanceof ApiError && statusQuery.error.status === 403) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Wrench className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Paperclip's own Claude key</h2>
              {status ? (
                status.configured ? (
                  status.lastTestOk === false ? (
                    <Badge variant="destructive">Needs attention</Badge>
                  ) : (
                    <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">In place</Badge>
                  )
                ) : (
                  <Badge variant="outline">Not set</Badge>
                )
              ) : null}
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Paperclip does a few things itself, without starting an agent: answering a quick question,
              working out who a request should go to, and checking finished work before it is marked done.
              Those need a Claude key of Paperclip's own. Make one at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                console.anthropic.com
              </a>{" "}
              and paste it below. It is stored encrypted on this server and never shown again.
            </p>
          </div>
          {status?.configured && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => test.mutate()}>
                {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Test
              </Button>
              {status.source === "stored" &&
                (confirmRemove ? (
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
                    Remove key
                  </Button>
                ))}
            </div>
          )}
        </div>

        {statusQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {actionError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {actionError}
          </div>
        )}

        {status && (
          <>
            <p className="text-sm">{status.headline}</p>
            {status.source === "stored" && (
              <div className="grid gap-3 md:grid-cols-3">
                <StatusBox label="Key" value={status.hint ?? "—"} hint="Only the last four characters are kept visible." />
                <StatusBox label="Last changed" value={formatDateTime(status.savedAt)} />
                <StatusBox
                  label="Last tested"
                  value={formatDateTime(status.lastTestAt)}
                  hint={status.lastTestMessage ?? undefined}
                />
              </div>
            )}
          </>
        )}

        <form
          className="space-y-2 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (keyLooksRight && !busy) save.mutate();
          }}
        >
          <Label htmlFor="server-claude-key">
            {status?.source === "stored" ? "Replace the key" : "Claude key"}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="server-claude-key"
              type="password"
              autoComplete="off"
              className="w-full max-w-md font-mono"
              placeholder="sk-ant-…"
              value={pastedKey}
              onChange={(event) => setPastedKey(event.target.value)}
              disabled={save.isPending}
              aria-invalid={pastedKey.length > 0 && !keyLooksRight}
            />
            <Button type="submit" size="sm" disabled={!keyLooksRight || busy}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              Save and test
            </Button>
          </div>
          {pastedKey.length > 0 && !keyLooksRight && (
            <p className="text-xs text-destructive">
              That does not look right yet: it should start with sk-ant- and be one long line with no spaces.
            </p>
          )}
        </form>
      </div>
    </section>
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

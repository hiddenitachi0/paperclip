import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Send, Unlink } from "lucide-react";
import type { TelegramLinkCode } from "@paperclipai/shared";
import { telegramChatApi } from "../api/telegramChat";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

/**
 * Hermes parity slice 1: link your own Telegram account, so the company's
 * Telegram bot answers your questions (as you, with your own access).
 *
 * The code is shown once, works once, and stops working after 15 minutes.
 * The person sends it to the bot as `/link CODE`; that is what proves the
 * Telegram side, and having this page open is what proves the Paperclip side.
 */
export function TelegramLinkCard() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusQuery = useQuery({ queryKey: queryKeys.auth.telegramLink, queryFn: () => telegramChatApi.linkStatus() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.auth.telegramLink });
  const fail = (fallback: string) => (err: unknown) => setError(err instanceof ApiError ? err.message : fallback);

  const codeMutation = useMutation({
    mutationFn: () => telegramChatApi.createLinkCode(),
    onSuccess: (result) => {
      setError(null);
      setCode(result);
      refresh();
    },
    onError: fail("Could not make a code."),
  });
  const unlinkMutation = useMutation({
    mutationFn: () => telegramChatApi.unlink(),
    onSuccess: () => {
      setError(null);
      setCode(null);
      refresh();
    },
    onError: fail("Could not unlink."),
  });

  const status = statusQuery.data;
  const expires = code ? new Date(code.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="rounded-[28px] border border-border/70 bg-card p-6 shadow-sm" data-testid="telegram-link-card">
      <div className="space-y-1">
        <h2 className="section-title">Telegram</h2>
        <p className="text-sm text-muted-foreground">
          Link your Telegram to ask your company's Telegram bot questions — for example "How did sales go last
          week?" — and get the answer there. You only get answers about what your own account may see.
        </p>
      </div>
      <div className="mt-4 space-y-3 text-sm">
        {statusQuery.isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : status?.linked ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              Linked{status.telegramUsername ? ` to @${status.telegramUsername}` : ""}
              {status.linkedAt ? ` since ${new Date(status.linkedAt).toLocaleDateString()}` : ""}.
            </p>
            <Button variant="outline" onClick={() => unlinkMutation.mutate()} disabled={unlinkMutation.isPending}>
              {unlinkMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Unlink className="size-4" />}
              Unlink
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground">Not linked yet.</p>
        )}

        {code ? (
          <div className="rounded-md border bg-muted/40 p-3">
            <p>
              Send this to the company's bot in Telegram, before {expires}:
            </p>
            <p className="mt-2 font-mono text-lg tracking-widest" data-testid="telegram-link-code">/link {code.code}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              The code works once. Ask your company's owner which bot to write to if you don't know.
            </p>
          </div>
        ) : null}

        {error ? <p className="text-destructive">{error}</p> : null}

        <Button variant={status?.linked ? "outline" : "default"} onClick={() => codeMutation.mutate()} disabled={codeMutation.isPending}>
          {codeMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
          {status?.linked ? "Link a different Telegram account" : "Link Telegram"}
        </Button>
      </div>
    </div>
  );
}

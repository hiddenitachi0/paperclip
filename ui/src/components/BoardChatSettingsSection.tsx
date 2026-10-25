import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BOARD_CHAT_MAX_DAILY_MESSAGE_CAP } from "@paperclipai/shared";
import { boardChatApi } from "../api/boardChat";
import { ApiError } from "../api/client";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { useConferenceRoomChatEnabled } from "../hooks/useConferenceRoomChatEnabled";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

export const BOARD_CHAT_RISK_TEXT =
  "Board chat lets this company's owner and admins ask Paperclip in plain words to look things up and make changes for them, " +
  "such as creating or changing tasks, hiring or adjusting agents, and deciding the CEO's strategy cards. It acts as the person who asks, " +
  "and only inside this company. Every change is shown first as a card with the exact details, and nothing happens until that " +
  "person clicks Approve. It can never decide deploy, merge, hire or money cards, and it has no access to the server itself. It answers with " +
  "the same model as Ask Paperclip (Company settings → General → Helper), and each message costs money; you can see the cost " +
  "under Costs. Turn it on only if you trust your admins to read each card before they approve it.";

/**
 * Company settings: "Board chat" on a signed-in Paperclip. The company's
 * owner (or an instance admin) switches it on, with the risk explained, and
 * sets how many messages a day the company may send. Hidden on a local
 * single-user Paperclip, where Board chat works as before.
 */
export function BoardChatSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), retry: false });
  const signedIn = health.data?.deploymentMode === "authenticated";
  const instanceFlag = useConferenceRoomChatEnabled();
  const role = useCompanyRole(companyId);
  const canChange = role.localBoard || role.isInstanceAdmin || role.role === "owner";
  const settings = useQuery({
    queryKey: queryKeys.boardChat.settings(companyId),
    queryFn: () => boardChatApi.getSettings(companyId),
    enabled: signedIn,
    retry: false,
  });
  const [capInput, setCapInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const savedCap = settings.data?.dailyMessageCap ?? null;
  useEffect(() => {
    if (savedCap !== null) setCapInput(String(savedCap));
  }, [savedCap]);

  const update = useMutation({
    mutationFn: (patch: { enabled?: boolean; dailyMessageCap?: number }) => boardChatApi.updateSettings(companyId, patch),
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(queryKeys.boardChat.settings(companyId), data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.boardChat.availability(companyId) });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not save this setting."),
  });

  if (!signedIn || !settings.data) return null;
  const enabled = settings.data.enabled;
  const parsedCap = Number(capInput);
  const capValid = Number.isInteger(parsedCap) && parsedCap >= 1 && parsedCap <= BOARD_CHAT_MAX_DAILY_MESSAGE_CAP;

  return (
    <div className="space-y-4" data-testid="company-settings-board-chat-section">
      <div className="section-title">Board chat</div>
      <div className="rounded-md section-box px-4 py-3 space-y-3">
        <p className="text-xs text-muted-foreground" data-testid="board-chat-risk-text">
          {BOARD_CHAT_RISK_TEXT}
        </p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">Let owners and admins use Board chat in this company</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Board chat"
            data-testid="company-settings-board-chat-toggle"
            disabled={!canChange || update.isPending}
            onClick={() => update.mutate({ enabled: !enabled })}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
              enabled ? "bg-green-600" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                enabled ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
        {!canChange ? (
          <p className="text-[11px] text-muted-foreground">Only the company's owner can turn Board chat on or off.</p>
        ) : null}
        {enabled && !instanceFlag.enabled && instanceFlag.loaded ? (
          <p className="text-[11px] text-muted-foreground">
            Board chat is also switched off for this whole Paperclip. Ask the person who runs your Paperclip to turn it on in
            Instance settings.
          </p>
        ) : null}
        <div className="space-y-1">
          <label htmlFor="board-chat-daily-cap" className="text-xs text-muted-foreground">
            Most messages per day for the whole company
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="board-chat-daily-cap"
              data-testid="company-settings-board-chat-cap"
              inputMode="numeric"
              className="h-8 w-24"
              value={capInput}
              disabled={!canChange}
              onChange={(e) => setCapInput(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!canChange || !capValid || parsedCap === savedCap || update.isPending}
              onClick={() => update.mutate({ dailyMessageCap: parsedCap })}
            >
              Save
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {settings.data.messagesToday} used today. The count starts again at midnight (UTC).
          </p>
          {!capValid ? (
            <p className="text-[11px] text-destructive">Enter a whole number from 1 to {BOARD_CHAT_MAX_DAILY_MESSAGE_CAP}.</p>
          ) : null}
          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

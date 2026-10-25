import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TELEGRAM_CHAT_DAILY_CAP_DEFAULT, TELEGRAM_CHAT_DAILY_CAP_MAX } from "@paperclipai/shared";
import { telegramChatApi } from "../api/telegramChat";
import { telegramBotsApi } from "../api/telegramBots";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/**
 * Hermes parity slice 1: "Questions from your team on Telegram".
 *
 * One company setting, owner/admin only: which of the company's Telegram bots
 * answers people (not just the people on its own list), which quick agent
 * answers first, which full agent takes a question the quick agent cannot
 * answer, and how many questions one person may ask per day. People link
 * their own Telegram from their profile page; the answers they get only ever
 * contain what their own Paperclip account may see.
 */

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

export function TelegramPeopleSection({ companyId, readOnly = false }: { companyId: string; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const settingsQuery = useQuery({
    queryKey: queryKeys.companies.telegramChatSettings(companyId),
    queryFn: () => telegramChatApi.getSettings(companyId),
  });
  const botsQuery = useQuery({
    queryKey: queryKeys.companies.telegramBots(companyId),
    queryFn: () => telegramBotsApi.list(companyId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const [enabled, setEnabled] = useState(false);
  const [botId, setBotId] = useState("");
  const [quickAgentId, setQuickAgentId] = useState("");
  const [fullAgentId, setFullAgentId] = useState("");
  const [cap, setCap] = useState(String(TELEGRAM_CHAT_DAILY_CAP_DEFAULT));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = settingsQuery.data;
    if (!s) return;
    setEnabled(s.enabled);
    setBotId(s.botId ?? "");
    setQuickAgentId(s.quickAgentId ?? "");
    setFullAgentId(s.fullAgentId ?? "");
    setCap(String(s.dailyQuestionsPerPerson));
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      telegramChatApi.updateSettings(companyId, {
        enabled,
        botId: botId || null,
        quickAgentId: quickAgentId || null,
        fullAgentId: fullAgentId || null,
        dailyQuestionsPerPerson: Math.max(1, Math.min(TELEGRAM_CHAT_DAILY_CAP_MAX, Number.parseInt(cap, 10) || 1)),
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.telegramChatSettings(companyId) });
      pushToast({ title: "Saved", body: "The Telegram bot picks this up within a minute.", tone: "success" });
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "Could not save."),
  });

  const bots = botsQuery.data ?? [];
  const agents = (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated");
  const quickAgents = agents.filter((agent) => agent.laneAEnabled);
  const disabled = readOnly || saveMutation.isPending;

  return (
    <Card data-testid="telegram-people-section">
      <CardHeader>
        <CardTitle>Questions from your team on Telegram</CardTitle>
        <CardDescription>
          Let people in this company ask one of your bots about the business — for example "How did sofas sell in
          September?" — and get the answer back in Telegram. Each person first links their own Telegram on their
          Paperclip profile page. The answer only contains what that person may see in Paperclip, and nobody else
          gets anything but a short "link your account first".
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {readOnly && (
          <p className="text-xs text-muted-foreground">Only the company owner or an admin can change this.</p>
        )}
        {settingsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Answer questions from linked people</p>
                <p className="text-xs text-muted-foreground">Off: the bots only talk to the people on their own list, as before.</p>
              </div>
              <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} aria-label="Answer questions from linked people" />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="telegram-people-bot">Which bot do people write to?</label>
                <select id="telegram-people-bot" className={selectClass} value={botId} disabled={disabled} onChange={(e) => setBotId(e.target.value)}>
                  <option value="">Choose a bot…</option>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}{bot.lastCheckUsername ? ` (@${bot.lastCheckUsername})` : ""}
                    </option>
                  ))}
                </select>
                {bots.length === 0 && <p className="text-xs text-muted-foreground">Connect a bot above first.</p>}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="telegram-people-cap">Questions per person per day</label>
                <Input
                  id="telegram-people-cap"
                  type="number"
                  min={1}
                  max={TELEGRAM_CHAT_DAILY_CAP_MAX}
                  value={cap}
                  disabled={disabled}
                  onChange={(e) => setCap(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Counted per person, starting again at midnight (Norway time).</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="telegram-people-quick">Who answers first? (a quick agent)</label>
                <select id="telegram-people-quick" className={selectClass} value={quickAgentId} disabled={disabled} onChange={(e) => setQuickAgentId(e.target.value)}>
                  <option value="">Nobody — send every question to the agent below</option>
                  {quickAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Answers short questions in seconds, using the company's sales data when it is connected. It only
                  answers the people it is assigned to on its own page (the owner always).
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="telegram-people-full">Who takes bigger questions? (a full agent)</label>
                <select id="telegram-people-full" className={selectClass} value={fullAgentId} disabled={disabled} onChange={(e) => setFullAgentId(e.target.value)}>
                  <option value="">Nobody — only quick answers</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Gets a task when the quick agent can't answer; its answer is sent back to the person's chat when
                  the task is done. People who may not give this agent tasks are told so instead.
                </p>
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {!readOnly && (
              <div className="flex justify-end">
                <Button onClick={() => saveMutation.mutate()} disabled={disabled}>
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

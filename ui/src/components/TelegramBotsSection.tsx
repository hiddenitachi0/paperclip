import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TelegramBotSummary } from "@paperclipai/shared";
import { telegramBotsApi } from "../api/telegramBots";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * DUR-3978 slice 2: where Filip connects a Telegram bot himself.
 *
 * Before this, connecting a bot meant someone editing a root-only JSON file on
 * the server with the token in plain text and restarting a service. Everything
 * on this card is written for the person doing that job: no ids, no jargon,
 * and nothing offered that he cannot do.
 *
 * The token field is never pre-filled and the token is never shown again — the
 * server stores it in the saved-password store and answers with a masked hint.
 *
 * DUR-3997: lives on the Connections page. `readOnly` hides every write action
 * for operators and viewers; the server routes keep their own checks.
 */

function statusText(bot: TelegramBotSummary): string {
  if (bot.lastCheckAt === null) return "Not tested yet";
  if (bot.lastCheckOk) {
    return bot.lastCheckUsername ? `Answers as @${bot.lastCheckUsername}` : "Answers";
  }
  return bot.lastCheckError ?? "Did not answer";
}

export function TelegramBotsSection({ companyId, readOnly = false }: { companyId: string; readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateToken, setRotateToken] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const botsQuery = useQuery({
    queryKey: queryKeys.companies.telegramBots(companyId),
    queryFn: () => telegramBotsApi.list(companyId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.telegramBots(companyId) });
  };
  const fail = (fallback: string) => (err: unknown) => {
    setError(err instanceof ApiError ? err.message : fallback);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      telegramBotsApi.create(companyId, { agentId, name: name.trim(), botToken: token.trim() }),
    onSuccess: () => {
      // Clear the token first: it must not sit in the page after it is saved.
      setToken("");
      setName("");
      setAgentId("");
      setError(null);
      invalidate();
      pushToast({ title: "Bot connected", tone: "success" });
    },
    onError: fail("Could not connect the bot"),
  });

  const rotateMutation = useMutation({
    mutationFn: (input: { botId: string; token: string }) =>
      telegramBotsApi.rotateToken(companyId, input.botId, input.token),
    onSuccess: () => {
      setRotateToken("");
      setRotatingId(null);
      setError(null);
      invalidate();
      pushToast({ title: "New token saved", tone: "success" });
    },
    onError: fail("Could not save the new token"),
  });

  const testMutation = useMutation({
    mutationFn: (botId: string) => telegramBotsApi.test(companyId, botId),
    onSuccess: (result) => {
      setError(null);
      invalidate();
      pushToast({ title: result.message, tone: result.ok ? "success" : "warn" });
    },
    onError: fail("Could not test the bot"),
  });

  const allowedUsersMutation = useMutation({
    mutationFn: (input: { botId: string; telegramUserIds: string[] }) =>
      telegramBotsApi.setAllowedUsers(companyId, input.botId, input.telegramUserIds),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: fail("Could not change who may use the bot"),
  });

  const removeMutation = useMutation({
    mutationFn: (botId: string) => telegramBotsApi.remove(companyId, botId),
    onSuccess: () => {
      setConfirmRemoveId(null);
      setError(null);
      invalidate();
      pushToast({ title: "Bot removed", tone: "success" });
    },
    onError: fail("Could not remove the bot"),
  });

  const bots = botsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const takenAgentIds = new Set(bots.map((bot) => bot.agentId));
  const availableAgents = agents.filter((agent) => !takenAgentIds.has(agent.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram bots</CardTitle>
        <CardDescription>
          A Telegram bot lets you talk to one of your agents straight from Telegram: you get notifications
          there, and what you write goes to the agent. Create the bot in Telegram with @BotFather and paste
          the token it gives you here. The token is stored as a secret and never shown again — but you can
          replace it at any time. Only the people you add below can use the bot, and only in ordinary
          one-to-one chat; groups are always refused.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {readOnly ? (
          <p className="text-xs text-muted-foreground">Only the company owner or an admin can connect or change bots.</p>
        ) : (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">Connect a new bot</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1 space-y-1.5">
                <label className="text-sm font-medium" htmlFor="telegram-bot-agent">
                  Who should answer?
                </label>
                <select
                  id="telegram-bot-agent"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  <option value="">Choose an agent…</option>
                  {availableAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-[10rem] flex-1 space-y-1.5">
                <label className="text-sm font-medium" htmlFor="telegram-bot-name">
                  What should the bot be called?
                </label>
                <Input
                  id="telegram-bot-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Managing director"
                  maxLength={80}
                />
              </div>
              <div className="min-w-[14rem] flex-1 space-y-1.5">
                <label className="text-sm font-medium" htmlFor="telegram-bot-token">
                  Token from BotFather
                </label>
                <Input
                  id="telegram-bot-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="8123456789:AAH…"
                />
              </div>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={!agentId || !name.trim() || !token.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? "Connecting…" : "Connect"}
              </Button>
            </div>
            {availableAgents.length === 0 && agents.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Every agent already has a bot.
              </p>
            )}
          </div>
        )}

        {botsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : botsQuery.isError ? (
          <p className="text-sm text-destructive" data-testid="telegram-bots-error">
            Could not load the bots: {botsQuery.error instanceof Error ? botsQuery.error.message : "unknown error"}
          </p>
        ) : bots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bots connected yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {bots.map((bot) => (
              <li key={bot.id} className="space-y-2 px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {bot.name}
                      {bot.agentName ? ` — answers as ${bot.agentName}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Token {bot.tokenHint} · {statusText(bot)}
                    </p>
                  </div>
                  {!readOnly && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => testMutation.mutate(bot.id)}
                        disabled={testMutation.isPending}
                      >
                        Test
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRotateToken("");
                          setRotatingId(rotatingId === bot.id ? null : bot.id);
                        }}
                      >
                        Replace token
                      </Button>
                      {confirmRemoveId === bot.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => removeMutation.mutate(bot.id)}
                            disabled={removeMutation.isPending}
                          >
                            Yes, remove the bot
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveId(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveId(bot.id)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {confirmRemoveId === bot.id && (
                  <p className="text-xs text-destructive">
                    The bot stops answering and the stored token is deleted. You can connect it again later
                    with a new token from BotFather.
                  </p>
                )}

                {rotatingId === bot.id && !readOnly && (
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-sm font-medium" htmlFor={`telegram-rotate-${bot.id}`}>
                        New token from BotFather
                      </label>
                      <Input
                        id={`telegram-rotate-${bot.id}`}
                        type="password"
                        autoComplete="off"
                        value={rotateToken}
                        onChange={(event) => setRotateToken(event.target.value)}
                        placeholder="8123456789:AAH…"
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => rotateMutation.mutate({ botId: bot.id, token: rotateToken.trim() })}
                      disabled={!rotateToken.trim() || rotateMutation.isPending}
                    >
                      Save
                    </Button>
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Who may use this bot</p>
                  {bot.allowedTelegramUserIds.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Nobody added yet — so the usual list of who may use the bots applies. Add your own
                      Telegram ID to decide it here.
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {bot.allowedTelegramUserIds.map((userId) => (
                        <li
                          key={userId}
                          className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                        >
                          <span>{userId}</span>
                          {!readOnly && (
                            <button
                              type="button"
                              className="text-muted-foreground hover:text-destructive"
                              aria-label={`Remove ${userId}`}
                              onClick={() =>
                                allowedUsersMutation.mutate({
                                  botId: bot.id,
                                  telegramUserIds: bot.allowedTelegramUserIds.filter((id) => id !== userId),
                                })
                              }
                            >
                              ×
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {!readOnly && (
                    <div className="flex items-end gap-2">
                      <Input
                        aria-label={`Telegram ID allowed to use ${bot.name}`}
                        value={newUserId[bot.id] ?? ""}
                        onChange={(event) =>
                          setNewUserId((current) => ({ ...current, [bot.id]: event.target.value }))
                        }
                        placeholder="123456789"
                        className="max-w-[12rem]"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!(newUserId[bot.id] ?? "").trim() || allowedUsersMutation.isPending}
                        onClick={() => {
                          const value = (newUserId[bot.id] ?? "").trim();
                          if (!value) return;
                          allowedUsersMutation.mutate({
                            botId: bot.id,
                            telegramUserIds: [...bot.allowedTelegramUserIds, value],
                          });
                          setNewUserId((current) => ({ ...current, [bot.id]: "" }));
                        }}
                      >
                        Add
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

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
 * on this card is written for the person doing that job, in Norwegian, like the
 * card next to it: no ids, no jargon, and nothing offered that he cannot do.
 *
 * The token field is never pre-filled and the token is never shown again — the
 * server stores it in the saved-password store and answers with a masked hint.
 */

function statusText(bot: TelegramBotSummary): string {
  if (bot.lastCheckAt === null) return "Ikke testet ennå";
  if (bot.lastCheckOk) {
    return bot.lastCheckUsername ? `Svarer som @${bot.lastCheckUsername}` : "Svarer";
  }
  return bot.lastCheckError ?? "Svarte ikke";
}

export function TelegramBotsSection({ companyId }: { companyId: string }) {
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
      telegramBotsApi.create(companyId, { agentId, name: name.trim(), token: token.trim() }),
    onSuccess: () => {
      // Clear the token first: it must not sit in the page after it is saved.
      setToken("");
      setName("");
      setAgentId("");
      setError(null);
      invalidate();
      pushToast({ title: "Boten er koblet til", tone: "success" });
    },
    onError: fail("Kunne ikke koble til boten"),
  });

  const rotateMutation = useMutation({
    mutationFn: (input: { botId: string; token: string }) =>
      telegramBotsApi.rotateToken(companyId, input.botId, input.token),
    onSuccess: () => {
      setRotateToken("");
      setRotatingId(null);
      setError(null);
      invalidate();
      pushToast({ title: "Nytt token lagret", tone: "success" });
    },
    onError: fail("Kunne ikke lagre det nye tokenet"),
  });

  const testMutation = useMutation({
    mutationFn: (botId: string) => telegramBotsApi.test(companyId, botId),
    onSuccess: (result) => {
      setError(null);
      invalidate();
      pushToast({ title: result.message, tone: result.ok ? "success" : "warn" });
    },
    onError: fail("Kunne ikke teste boten"),
  });

  const allowedUsersMutation = useMutation({
    mutationFn: (input: { botId: string; telegramUserIds: string[] }) =>
      telegramBotsApi.setAllowedUsers(companyId, input.botId, input.telegramUserIds),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: fail("Kunne ikke endre hvem som får bruke boten"),
  });

  const removeMutation = useMutation({
    mutationFn: (botId: string) => telegramBotsApi.remove(companyId, botId),
    onSuccess: () => {
      setConfirmRemoveId(null);
      setError(null);
      invalidate();
      pushToast({ title: "Boten er fjernet", tone: "success" });
    },
    onError: fail("Kunne ikke fjerne boten"),
  });

  const bots = botsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const takenAgentIds = new Set(bots.map((bot) => bot.agentId));
  const availableAgents = agents.filter((agent) => !takenAgentIds.has(agent.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Telegram-boter</CardTitle>
        <CardDescription>
          En Telegram-bot lar deg snakke med én av de ansatte rett i Telegram: du får varsler der, og
          det du skriver går til den ansatte. Du lager boten i Telegram hos @BotFather, og limer inn
          tokenet den gir deg her. Tokenet lagres som et passord og vises aldri igjen — men du kan
          bytte det når som helst. Bare personene du legger inn nedenfor kan bruke boten, og bare i
          vanlig én-til-én-chat; grupper blir alltid avvist.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Koble til en ny bot</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[12rem] flex-1 space-y-1.5">
              <label className="text-sm font-medium" htmlFor="telegram-bot-agent">
                Hvem skal svare?
              </label>
              <select
                id="telegram-bot-agent"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
              >
                <option value="">Velg en ansatt…</option>
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[10rem] flex-1 space-y-1.5">
              <label className="text-sm font-medium" htmlFor="telegram-bot-name">
                Hva skal boten hete?
              </label>
              <Input
                id="telegram-bot-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Daglig leder"
                maxLength={80}
              />
            </div>
            <div className="min-w-[14rem] flex-1 space-y-1.5">
              <label className="text-sm font-medium" htmlFor="telegram-bot-token">
                Token fra BotFather
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
              {createMutation.isPending ? "Kobler til…" : "Koble til"}
            </Button>
          </div>
          {availableAgents.length === 0 && agents.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Alle de ansatte har allerede hver sin bot.
            </p>
          )}
        </div>

        {botsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Henter…</p>
        ) : bots.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ingen boter er koblet til ennå.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {bots.map((bot) => (
              <li key={bot.id} className="space-y-2 px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {bot.name}
                      {bot.agentName ? ` — svarer som ${bot.agentName}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Token {bot.tokenHint} · {statusText(bot)}
                    </p>
                  </div>
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
                      Bytt token
                    </Button>
                    {confirmRemoveId === bot.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => removeMutation.mutate(bot.id)}
                          disabled={removeMutation.isPending}
                        >
                          Ja, fjern boten
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveId(null)}>
                          Avbryt
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveId(bot.id)}>
                        Fjern
                      </Button>
                    )}
                  </div>
                </div>

                {confirmRemoveId === bot.id && (
                  <p className="text-xs text-destructive">
                    Boten slutter å svare, og det lagrede tokenet slettes. Du kan koble den til igjen
                    senere med et nytt token fra BotFather.
                  </p>
                )}

                {rotatingId === bot.id && (
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-sm font-medium" htmlFor={`telegram-rotate-${bot.id}`}>
                        Nytt token fra BotFather
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
                      Lagre
                    </Button>
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Hvem får bruke denne boten</p>
                  {bot.allowedTelegramUserIds.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Ingen lagt til ennå — da gjelder den vanlige listen over hvem som får bruke
                      botene. Legg inn din egen Telegram-ID for å bestemme det her.
                    </p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {bot.allowedTelegramUserIds.map((userId) => (
                        <li
                          key={userId}
                          className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                        >
                          <span>{userId}</span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive"
                            aria-label={`Fjern ${userId}`}
                            onClick={() =>
                              allowedUsersMutation.mutate({
                                botId: bot.id,
                                telegramUserIds: bot.allowedTelegramUserIds.filter((id) => id !== userId),
                              })
                            }
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex items-end gap-2">
                    <Input
                      aria-label={`Telegram-ID som får bruke ${bot.name}`}
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
                      Legg til
                    </Button>
                  </div>
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

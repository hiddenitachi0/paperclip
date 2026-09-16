import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecretBindings, telegramBots } from "@paperclipai/db";
import type { TelegramBotCheckResult, TelegramBotSummary } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

/**
 * DUR-3978 slice 2: Telegram bot connections the operator makes in the app,
 * instead of by editing /root/paperclip/.telegram-agents.json as root.
 *
 * The one rule this file exists to enforce: the bot token is a credential, so
 * it lives in the company secret store and is read back in exactly one place
 * (`resolveBotToken`, behind the instance-admin-only bridge-token route). No
 * other function here returns it, and `toSummary` — the shape every ordinary
 * read route answers with — has no field it could travel in.
 */

// One credential per bot, always at this configPath. A constant rather than a
// caller-supplied string so a typo cannot create an unreachable second
// binding. Same reasoning as PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH.
export const TELEGRAM_BOT_TOKEN_CONFIG_PATH = "bot_token";

const TELEGRAM_API_TIMEOUT_MS = 10_000;

/**
 * The part of a token it is safe to show. A Telegram token is
 * `<public bot account id>:<secret>`, so the half before the colon is not a
 * secret at all — it is how Telegram itself identifies the bot publicly.
 */
export function telegramBotTokenHint(token: string): string {
  const separator = token.indexOf(":");
  if (separator < 0) return "••••";
  return `${token.slice(0, separator)}:••••${token.slice(-4)}`;
}

type TelegramBotRow = typeof telegramBots.$inferSelect;

function toSummary(row: TelegramBotRow, agentName: string | null): TelegramBotSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    agentName,
    name: row.name,
    tokenHint: row.tokenHint,
    uiBase: row.uiBase,
    allowedTelegramUserIds: row.allowedTelegramUserIds ?? [],
    enabled: row.enabled,
    lastCheckAt: row.lastCheckAt ? row.lastCheckAt.toISOString() : null,
    lastCheckOk: row.lastCheckOk,
    lastCheckUsername: row.lastCheckUsername,
    lastCheckError: row.lastCheckError,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Ask Telegram who this bot is.
 *
 * Fail-closed in the only sense that matters here: anything other than a
 * confirmed answer is reported as "not reachable". The token is in the URL, so
 * NOTHING from the failure — not the error message, not the URL, not the
 * response body — is ever passed through to the caller or to a log. Every
 * failure is mapped to one of the fixed sentences below.
 */
export async function checkTelegramBotToken(
  token: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; username: string | null; message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      username: null,
      message: "Fikk ikke kontakt med Telegram. Prøv igjen om litt — det er som regel nettet, ikke boten.",
    };
  }
  if (response.status === 401 || response.status === 404) {
    return {
      ok: false,
      username: null,
      message:
        "Telegram kjenner ikke igjen dette tokenet. Hent et nytt fra BotFather (/token) og lim det inn på nytt.",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      username: null,
      message: "Telegram svarte ikke som forventet. Prøv igjen om litt.",
    };
  }
  let username: string | null = null;
  try {
    const body = (await response.json()) as { ok?: boolean; result?: { username?: string } };
    if (body?.ok !== true) {
      return { ok: false, username: null, message: "Telegram svarte, men godtok ikke tokenet." };
    }
    username = typeof body.result?.username === "string" ? body.result.username : null;
  } catch {
    return { ok: false, username: null, message: "Telegram svarte ikke som forventet. Prøv igjen om litt." };
  }
  return {
    ok: true,
    username,
    message: username ? `Boten svarer som @${username}.` : "Boten svarer.",
  };
}

export function telegramBotService(db: Db, deps: { fetchImpl?: typeof fetch } = {}) {
  const secrets = secretService(db);

  async function getAgentInCompany(companyId: string, agentId: string) {
    const [agent] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    return agent ?? null;
  }

  async function agentNames(companyId: string): Promise<Map<string, string>> {
    const rows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async function listRows(companyId: string): Promise<TelegramBotRow[]> {
    return db.select().from(telegramBots).where(eq(telegramBots.companyId, companyId));
  }

  async function list(companyId: string): Promise<TelegramBotSummary[]> {
    const [rows, names] = await Promise.all([listRows(companyId), agentNames(companyId)]);
    return rows
      .map((row) => toSummary(row, names.get(row.agentId) ?? null))
      .sort((a, b) => a.name.localeCompare(b.name, "nb"));
  }

  async function getRow(companyId: string, botId: string): Promise<TelegramBotRow> {
    const [row] = await db
      .select()
      .from(telegramBots)
      .where(and(eq(telegramBots.id, botId), eq(telegramBots.companyId, companyId)));
    if (!row) throw notFound("Telegram bot not found");
    return row;
  }

  async function get(companyId: string, botId: string): Promise<TelegramBotSummary> {
    const row = await getRow(companyId, botId);
    const names = await agentNames(companyId);
    return toSummary(row, names.get(row.agentId) ?? null);
  }

  /**
   * A secret name the operator will recognise in the Secrets screen. The
   * agent's name is used rather than an id, because this string is shown to
   * him; the numeric suffix only appears if that name is somehow taken.
   */
  async function createTokenSecret(
    companyId: string,
    agentName: string,
    token: string,
    actor: { userId: string | null },
  ) {
    const base = `Telegram-bot for ${agentName}`;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const name = attempt === 0 ? base : `${base} (${attempt + 1})`;
      const existing = await secrets.getByName(companyId, name);
      if (existing) continue;
      return secrets.create(
        companyId,
        {
          name,
          provider: "local_encrypted",
          value: token,
          description: "Bot-token fra BotFather. Brukes bare av Telegram-koblingen.",
        },
        // agentId is null on purpose: this secret is created by the operator,
        // never by an agent, so it can never qualify for the DUR-3980
        // "an agent may re-attach a secret it minted itself" exemption.
        { userId: actor.userId, agentId: null },
      );
    }
    throw conflict("Could not name the saved password for this bot");
  }

  async function create(
    companyId: string,
    input: { agentId: string; name: string; token: string; uiBase?: string | null },
    actor: { userId: string | null },
  ): Promise<TelegramBotSummary> {
    const agent = await getAgentInCompany(companyId, input.agentId);
    if (!agent) throw notFound("Agent not found");

    const [existing] = await db
      .select({ id: telegramBots.id })
      .from(telegramBots)
      .where(and(eq(telegramBots.companyId, companyId), eq(telegramBots.agentId, input.agentId)));
    if (existing) {
      throw conflict("This agent already has a Telegram bot. Remove the old one first.");
    }

    const secret = await createTokenSecret(companyId, agent.name, input.token, actor);
    let row: TelegramBotRow;
    try {
      [row] = await db
        .insert(telegramBots)
        .values({
          companyId,
          agentId: input.agentId,
          name: input.name,
          tokenSecretId: secret.id,
          tokenHint: telegramBotTokenHint(input.token),
          uiBase: input.uiBase ?? null,
          allowedTelegramUserIds: [],
          enabled: true,
          createdByUserId: actor.userId,
        })
        .returning();
    } catch (error) {
      // Never leave an orphan credential behind: if the row could not be
      // written, the saved password it points at has no owner.
      await secrets.remove(secret.id).catch(() => undefined);
      throw error;
    }

    // The binding is what makes the token resolvable at all (see
    // resolveBotToken) and what makes it show up as "in use" on the Secrets
    // screen, so the operator can see it is not a stray password.
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: "telegram_bot", targetId: row.id },
      [{ secretId: secret.id, configPath: TELEGRAM_BOT_TOKEN_CONFIG_PATH, label: `Telegram: ${input.name}` }],
      { replaceAll: true },
    );

    return toSummary(row, agent.name);
  }

  async function rotateToken(
    companyId: string,
    botId: string,
    token: string,
    actor: { userId: string | null },
  ): Promise<TelegramBotSummary> {
    const row = await getRow(companyId, botId);
    await secrets.rotate(row.tokenSecretId, { value: token }, { userId: actor.userId, agentId: null });
    const [updated] = await db
      .update(telegramBots)
      .set({
        tokenHint: telegramBotTokenHint(token),
        // The previous check said something about a token that no longer
        // exists. Clearing it is the honest state: unknown, not "reachable".
        lastCheckAt: null,
        lastCheckOk: null,
        lastCheckUsername: null,
        lastCheckError: null,
        updatedAt: new Date(),
      })
      .where(eq(telegramBots.id, row.id))
      .returning();
    const names = await agentNames(companyId);
    return toSummary(updated ?? row, names.get(row.agentId) ?? null);
  }

  async function setAllowedUsers(
    companyId: string,
    botId: string,
    telegramUserIds: string[],
  ): Promise<TelegramBotSummary> {
    const row = await getRow(companyId, botId);
    const unique = [...new Set(telegramUserIds.map((id) => id.trim()).filter(Boolean))];
    const [updated] = await db
      .update(telegramBots)
      .set({ allowedTelegramUserIds: unique, updatedAt: new Date() })
      .where(eq(telegramBots.id, row.id))
      .returning();
    const names = await agentNames(companyId);
    return toSummary(updated ?? row, names.get(row.agentId) ?? null);
  }

  async function remove(companyId: string, botId: string): Promise<{ removedSecretId: string }> {
    const row = await getRow(companyId, botId);
    // Order matters: the bot row goes first so nothing can resolve the token
    // through a binding while the secret is being deleted, then the binding,
    // then the secret itself.
    await db.delete(telegramBots).where(eq(telegramBots.id, row.id));
    await secrets
      .syncSecretRefsForTarget(companyId, { targetType: "telegram_bot", targetId: row.id }, [], { replaceAll: true })
      .catch(() => undefined);
    await secrets.remove(row.tokenSecretId);
    return { removedSecretId: row.tokenSecretId };
  }

  /**
   * The ONLY path from a bot row back to the token value.
   *
   * It goes through the real company_secret_bindings row rather than reading
   * company_secret_versions directly, so the read is authorised exactly like
   * every other credential read in Paperclip and lands in
   * secret_access_events. Authorisation of the CALLER is the route's job —
   * and the only route that calls this is instance-admin-only.
   */
  async function resolveBotToken(
    companyId: string,
    botId: string,
    context: { actorType: "system" | "user"; actorId: string },
  ): Promise<string> {
    const row = await getRow(companyId, botId);
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "telegram_bot"),
          eq(companySecretBindings.targetId, row.id),
          eq(companySecretBindings.configPath, TELEGRAM_BOT_TOKEN_CONFIG_PATH),
        ),
      );
    if (!binding) {
      throw unprocessable("No bot token is bound to this Telegram bot.", { code: "binding_missing" });
    }
    return secrets.resolveSecretValue(companyId, binding.secretId, "latest", {
      consumerType: "telegram_bot",
      consumerId: row.id,
      configPath: TELEGRAM_BOT_TOKEN_CONFIG_PATH,
      actorType: context.actorType,
      actorId: context.actorId,
    });
  }

  /**
   * Ask Telegram whether this bot is reachable and remember the answer, so the
   * list can say "reachable" without calling Telegram on every page load.
   */
  async function check(
    companyId: string,
    botId: string,
    context: { actorType: "system" | "user"; actorId: string },
  ): Promise<TelegramBotCheckResult> {
    const token = await resolveBotToken(companyId, botId, context);
    const result = await checkTelegramBotToken(token, deps);
    const checkedAt = new Date();
    await db
      .update(telegramBots)
      .set({
        lastCheckAt: checkedAt,
        lastCheckOk: result.ok,
        lastCheckUsername: result.username,
        lastCheckError: result.ok ? null : result.message,
        updatedAt: checkedAt,
      })
      .where(and(eq(telegramBots.id, botId), eq(telegramBots.companyId, companyId)));
    return { ...result, checkedAt: checkedAt.toISOString() };
  }

  return {
    list,
    listRows,
    get,
    getRow,
    create,
    rotateToken,
    setAllowedUsers,
    remove,
    resolveBotToken,
    check,
  };
}

export type TelegramBotService = ReturnType<typeof telegramBotService>;

/**
 * DUR-3978 slice 2: what the app knows about a connected Telegram bot.
 *
 * There is no `token` field anywhere in this file, and that is the point: the
 * shape the ordinary read routes return simply has no room for one. The token
 * reaches exactly one place — the instance-admin-only bridge-config route,
 * whose separate type below is the only one that carries it.
 */
export type TelegramBotSummary = {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  name: string;
  /**
   * The public half of the token plus the last four characters, e.g.
   * `8123456789:••••bQ4t`. Enough to tell two bots apart, not enough to use
   * one — the part before the colon is the bot's public account id.
   */
  tokenHint: string;
  uiBase: string | null;
  allowedTelegramUserIds: string[];
  enabled: boolean;
  /**
   * True for the one bot (at most one per company) that gets this company's
   * approvals and questions when no agent's own bot, or its boss's, should —
   * a card the board filed itself, for example.
   */
  receivesCompanyNotices: boolean;
  /** When the bot reads its answer aloud: never, when the person sent a voice message, or always. */
  voiceReplyMode: "never" | "when_voice" | "always";
  /** The voice it reads with; null means the default voice. */
  voice: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckUsername: string | null;
  lastCheckError: string | null;
  createdAt: string;
};

/** The answer to "is this bot reachable?", in words the operator can act on. */
export type TelegramBotCheckResult = {
  ok: boolean;
  /** The bot's @username, when Telegram answered. */
  username: string | null;
  /** Plain-language explanation when it did not. */
  message: string;
  checkedAt: string;
};

/**
 * One bot as the host-side bridge needs it. This is the ONLY shape that
 * carries a token, and it is returned by one instance-admin-only route.
 */
export type TelegramBridgeBot = {
  id: string;
  agentId: string;
  name: string;
  companyId: string;
  uiBase: string | null;
  allowedUserIds: string[];
  /**
   * The rest is how the bridge picks the bot that gets the company's
   * approvals and questions when no agent's own bot should: the marked bot,
   * else the CEO's bot (`agentRole` "ceo"), else the oldest (`createdAt`).
   */
  receivesCompanyNotices: boolean;
  createdAt: string;
  agentRole: string | null;
  /** Voice messages: when the bot reads its answer aloud, and with which voice (null = default). */
  voiceReplyMode: "never" | "when_voice" | "always";
  voice: string | null;
  token: string;
};

export type TelegramBridgeConfig = {
  bots: TelegramBridgeBot[];
};

import { and, asc, desc, eq, ilike, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, mailAccounts, mailMessages } from "@paperclipai/db";
import {
  MAIL_ACCOUNT_TICK_BATCH,
  MAIL_LIST_DEFAULT_LIMIT,
  MAIL_LIST_MAX_LIMIT,
  type ComposeMailDraftInput,
  type CreateMailAccountInput,
  type MailMessageFolder,
  type UpdateMailAccountInput,
  type UpdateMailDraftInput,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  fetchNewAccountMailMessages,
  type FetchedAccountMailMessage,
  type MailAccountImapConnectionConfig,
} from "./mail-account-imap-client.js";
import { sendAccountMail, type MailAccountSmtpConnectionConfig } from "./mail-account-smtp-client.js";
import { privateAccessService } from "./private-access.js";
import { secretService } from "./secrets.js";

/**
 * DUR-4194: per-person mail accounts -- a real IMAP/SMTP mailbox, read,
 * searched, replied to (with an AI draft) and sent from inside Paperclip.
 * See packages/db/src/schema/mail_accounts.ts for the full design note this
 * mirrors.
 *
 * Who may do what (the ticket's security requirement -- "no admin snooping
 * except emergency-logged access"):
 *   - config (create/update/remove the account, its host/credential fields):
 *     the owner themself, or a company owner/admin setting it up on their
 *     behalf (onboarding).
 *   - content (inbox, search, a message, drafts, move, archive): the owner,
 *     or the account's paAgentId agent acting as itself -- never a company
 *     owner/admin, not even an instance admin, through the ordinary read
 *     path. The one way an owner/admin reaches content is
 *     emergencyReadMessages, which always logs a reasoned
 *     private_access_events row (targetKind "mail_account") first.
 *   - sendDraft: the owner alone, and only as a board actor (never an
 *     agent). This is the whole "AI drafts, a human presses Send" rule,
 *     enforced by actor identity and type, not by convention -- see that
 *     function's own doc comment.
 *
 * Route callers are expected to resolve `MailAccountActor` from `req.actor`
 * and pass it to every function below; nothing in this file reads Express
 * request state directly.
 */

export const MAIL_ACCOUNT_IMAP_CREDENTIAL_CONFIG_PATH = "imap_password";
export const MAIL_ACCOUNT_SMTP_CREDENTIAL_CONFIG_PATH = "smtp_password";
export const MAIL_ACCOUNT_CHECK_LEASE_MS = 5 * 60_000;
export const MAIL_ACCOUNT_TICK_LIMIT = 25;
export const MAIL_ACCOUNT_MAX_BACKOFF_MS = 6 * 3_600_000;

type MailAccountRow = typeof mailAccounts.$inferSelect;
type MailMessageRow = typeof mailMessages.$inferSelect;

export interface MailAccountActor {
  /** "board" (a signed-in human) or "agent" (an API-key-authenticated agent run). */
  type: "board" | "agent";
  userId: string | null;
  agentId: string | null;
  /** True once a caller has already passed the owner/admin gate at the route layer. */
  isCompanyOwnerOrAdmin: boolean;
}

export interface MailAccountSummary {
  id: string;
  ownerUserId: string;
  paAgentId: string | null;
  displayName: string;
  emailAddress: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  imapMailbox: string;
  hasImapCredential: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  hasSmtpCredential: boolean;
  enabled: boolean;
  checkEveryMinutes: number;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  consecutiveFailures: number;
  createdAt: string;
}

export interface MailMessageSummary {
  id: string;
  accountId: string;
  folder: MailMessageFolder;
  direction: "inbound" | "outbound";
  messageId: string | null;
  inReplyToMessageId: string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  isRead: boolean;
  isDraft: boolean;
  aiDrafted: boolean;
  receivedAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface MailAccountTickResult {
  checked: number;
  fetched: number;
  errors: number;
}

export interface MailAccountServiceDeps {
  now?: () => Date;
  fetchMessages?: (
    config: MailAccountImapConnectionConfig,
    sinceUid: number | null,
    maxMessages: number,
  ) => Promise<FetchedAccountMailMessage[]>;
  sendMail?: typeof sendAccountMail;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function isOwner(actor: MailAccountActor, row: MailAccountRow): boolean {
  return actor.type === "board" && actor.userId !== null && actor.userId === row.ownerUserId;
}

function isPaAgent(actor: MailAccountActor, row: MailAccountRow): boolean {
  return actor.type === "agent" && actor.agentId !== null && actor.agentId === row.paAgentId;
}

/** The boundary for every content read/write below: owner, their PA agent, or (handled separately) a logged emergency access. */
function assertContentAccess(actor: MailAccountActor, row: MailAccountRow): void {
  if (isOwner(actor, row) || isPaAgent(actor, row)) return;
  throw forbidden("This mailbox belongs to someone else. Reading it requires emergency access, which is logged.");
}

/** Config access: the owner, or a company owner/admin (checked by the route) setting the account up. */
function assertConfigAccess(actor: MailAccountActor, row: MailAccountRow): void {
  if (isOwner(actor, row) || actor.isCompanyOwnerOrAdmin) return;
  throw forbidden("Only this mailbox's owner, or a company owner/admin, can change its settings.");
}

/**
 * A company owner/admin who is NOT the mailbox owner must not be able to
 * repoint an already-bound credential at a connection target they chose
 * (changing imapHost/imapPort/imapUsername, or the smtp equivalents) --
 * the next sync tick or send would then authenticate the owner's real
 * stored password against that admin-chosen host. The owner themself can
 * always repoint their own connection (they already hold the password), and
 * an admin may still rebind/clear the credential itself -- but if they do
 * both at once the row never carries the old secret into the new target.
 */
function assertConnectionTargetChangeAllowed(
  actor: MailAccountActor,
  row: MailAccountRow,
  next: { imapHost: string; imapPort: number; imapUsername: string; smtpHost: string; smtpPort: number; smtpUsername: string },
  credentialChanged: { imap: boolean; smtp: boolean },
): void {
  if (isOwner(actor, row)) return;
  const imapTargetChanged = next.imapHost !== row.imapHost || next.imapPort !== row.imapPort || next.imapUsername !== row.imapUsername;
  if (imapTargetChanged && row.imapCredentialSecretId && !credentialChanged.imap) {
    throw forbidden(
      "Changing the IMAP host/port/username on an account with a bound credential requires the mailbox owner, or clearing/replacing the credential in the same change.",
    );
  }
  const smtpTargetChanged = next.smtpHost !== row.smtpHost || next.smtpPort !== row.smtpPort || next.smtpUsername !== row.smtpUsername;
  if (smtpTargetChanged && row.smtpCredentialSecretId && !credentialChanged.smtp) {
    throw forbidden(
      "Changing the SMTP host/port/username on an account with a bound credential requires the mailbox owner, or clearing/replacing the credential in the same change.",
    );
  }
}

export function mailAccountsService(db: Db, deps: MailAccountServiceDeps = {}) {
  const secrets = secretService(db);
  const privateAccess = privateAccessService(db);
  const fetchMessages = deps.fetchMessages ?? fetchNewAccountMailMessages;
  const sendMail = deps.sendMail ?? sendAccountMail;
  const nowOf = () => deps.now?.() ?? new Date();

  // ─── Reading accounts ──────────────────────────────────────────────────────

  function toAccountSummary(row: MailAccountRow): MailAccountSummary {
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      paAgentId: row.paAgentId,
      displayName: row.displayName,
      emailAddress: row.emailAddress,
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      imapSecure: row.imapSecure,
      imapUsername: row.imapUsername,
      imapMailbox: row.imapMailbox,
      hasImapCredential: Boolean(row.imapCredentialSecretId),
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      smtpSecure: row.smtpSecure,
      smtpUsername: row.smtpUsername,
      hasSmtpCredential: Boolean(row.smtpCredentialSecretId),
      enabled: row.enabled,
      checkEveryMinutes: row.checkEveryMinutes,
      lastCheckAt: iso(row.lastCheckAt),
      lastCheckOk: row.lastCheckOk,
      lastCheckMessage: row.lastCheckMessage,
      consecutiveFailures: row.consecutiveFailures,
      createdAt: row.createdAt.toISOString(),
    };
  }

  function toMessageSummary(row: MailMessageRow): MailMessageSummary {
    return {
      id: row.id,
      accountId: row.accountId,
      folder: row.folder as MailMessageFolder,
      direction: row.direction as "inbound" | "outbound",
      messageId: row.messageId,
      inReplyToMessageId: row.inReplyToMessageId,
      fromAddress: row.fromAddress,
      toAddresses: row.toAddresses,
      ccAddresses: row.ccAddresses,
      subject: row.subject,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      isRead: row.isRead,
      isDraft: row.isDraft,
      aiDrafted: row.aiDrafted,
      receivedAt: iso(row.receivedAt),
      sentAt: iso(row.sentAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async function getAccountRow(companyId: string, accountId: string): Promise<MailAccountRow> {
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(and(eq(mailAccounts.id, accountId), eq(mailAccounts.companyId, companyId)));
    if (!row) throw notFound("Mail account not found");
    return row;
  }

  /** Every account this actor may configure or use -- their own, plus any they are the PA for. */
  async function listMyAccounts(companyId: string, actor: MailAccountActor): Promise<MailAccountSummary[]> {
    const conditions = [eq(mailAccounts.companyId, companyId)];
    if (actor.type === "board" && actor.userId) {
      conditions.push(eq(mailAccounts.ownerUserId, actor.userId));
    } else if (actor.type === "agent" && actor.agentId) {
      conditions.push(eq(mailAccounts.paAgentId, actor.agentId));
    } else {
      return [];
    }
    const rows = await db
      .select()
      .from(mailAccounts)
      .where(and(...conditions))
      .orderBy(asc(mailAccounts.createdAt));
    return rows.map(toAccountSummary);
  }

  /** Owner/admin configuration view: every account in the company, metadata only (never message content). */
  async function listAllAccounts(companyId: string): Promise<MailAccountSummary[]> {
    const rows = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.companyId, companyId))
      .orderBy(asc(mailAccounts.createdAt));
    return rows.map(toAccountSummary);
  }

  async function getAccount(companyId: string, accountId: string, actor: MailAccountActor): Promise<MailAccountSummary> {
    const row = await getAccountRow(companyId, accountId);
    assertConfigAccess(actor, row);
    return toAccountSummary(row);
  }

  // ─── Writing accounts ──────────────────────────────────────────────────────

  async function assertPaAgentInCompany(companyId: string, agentId: string) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent) throw unprocessable("Pick an agent from this company as the PA.");
  }

  async function syncCredentialBindings(
    companyId: string,
    accountId: string,
    name: string,
    imapSecretId: string | null,
    smtpSecretId: string | null,
  ) {
    const refs: Array<{ secretId: string; configPath: string; label: string }> = [];
    if (imapSecretId) {
      refs.push({ secretId: imapSecretId, configPath: MAIL_ACCOUNT_IMAP_CREDENTIAL_CONFIG_PATH, label: `Mail account: ${name} (IMAP)` });
    }
    if (smtpSecretId) {
      refs.push({ secretId: smtpSecretId, configPath: MAIL_ACCOUNT_SMTP_CREDENTIAL_CONFIG_PATH, label: `Mail account: ${name} (SMTP)` });
    }
    await secrets.syncSecretRefsForTarget(companyId, { targetType: "mail_account", targetId: accountId }, refs, { replaceAll: true });
  }

  async function createAccount(
    companyId: string,
    input: CreateMailAccountInput,
    actor: MailAccountActor,
  ): Promise<MailAccountSummary> {
    if (!(actor.type === "board" && actor.userId === input.ownerUserId) && !actor.isCompanyOwnerOrAdmin) {
      throw forbidden("Only this mailbox's owner, or a company owner/admin, can set it up.");
    }
    if (input.paAgentId) await assertPaAgentInCompany(companyId, input.paAgentId);
    const now = nowOf();
    const [row] = await db
      .insert(mailAccounts)
      .values({
        companyId,
        ownerUserId: input.ownerUserId,
        paAgentId: input.paAgentId,
        displayName: input.displayName,
        emailAddress: input.emailAddress,
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        imapSecure: input.imapSecure,
        imapUsername: input.imapUsername,
        imapMailbox: input.imapMailbox,
        imapCredentialSecretId: input.imapCredentialSecretId,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpSecure: input.smtpSecure,
        smtpUsername: input.smtpUsername,
        smtpCredentialSecretId: input.smtpCredentialSecretId,
        enabled: input.enabled,
        checkEveryMinutes: input.checkEveryMinutes,
        nextCheckAt: now,
        createdByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Mail account insert returned no row");
    try {
      await syncCredentialBindings(companyId, row.id, row.displayName, input.imapCredentialSecretId, input.smtpCredentialSecretId);
    } catch (err) {
      // A binding that cannot be made (a secret from another company, or one
      // already dedicated elsewhere) must not leave an account pointed at
      // credentials it does not actually have.
      await db.delete(mailAccounts).where(eq(mailAccounts.id, row.id));
      throw err;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "mail_account.created",
      entityType: "mail_account",
      entityId: row.id,
      details: { displayName: row.displayName, ownerUserId: row.ownerUserId },
    });
    return toAccountSummary(row);
  }

  async function updateAccount(
    companyId: string,
    accountId: string,
    patch: UpdateMailAccountInput,
    actor: MailAccountActor,
  ): Promise<MailAccountSummary> {
    const row = await getAccountRow(companyId, accountId);
    assertConfigAccess(actor, row);
    if (patch.paAgentId !== undefined && patch.paAgentId && patch.paAgentId !== row.paAgentId) {
      await assertPaAgentInCompany(companyId, patch.paAgentId);
    }
    const next = {
      paAgentId: patch.paAgentId !== undefined ? patch.paAgentId : row.paAgentId,
      displayName: patch.displayName ?? row.displayName,
      emailAddress: patch.emailAddress ?? row.emailAddress,
      imapHost: patch.imapHost ?? row.imapHost,
      imapPort: patch.imapPort ?? row.imapPort,
      imapSecure: patch.imapSecure ?? row.imapSecure,
      imapUsername: patch.imapUsername ?? row.imapUsername,
      imapMailbox: patch.imapMailbox ?? row.imapMailbox,
      imapCredentialSecretId: patch.imapCredentialSecretId !== undefined ? patch.imapCredentialSecretId : row.imapCredentialSecretId,
      smtpHost: patch.smtpHost ?? row.smtpHost,
      smtpPort: patch.smtpPort ?? row.smtpPort,
      smtpSecure: patch.smtpSecure ?? row.smtpSecure,
      smtpUsername: patch.smtpUsername ?? row.smtpUsername,
      smtpCredentialSecretId: patch.smtpCredentialSecretId !== undefined ? patch.smtpCredentialSecretId : row.smtpCredentialSecretId,
      enabled: patch.enabled ?? row.enabled,
      checkEveryMinutes: patch.checkEveryMinutes ?? row.checkEveryMinutes,
    };
    const imapChanged =
      next.imapHost !== row.imapHost ||
      next.imapPort !== row.imapPort ||
      next.imapUsername !== row.imapUsername ||
      next.imapMailbox !== row.imapMailbox ||
      next.imapCredentialSecretId !== row.imapCredentialSecretId;
    assertConnectionTargetChangeAllowed(actor, row, next, {
      imap: next.imapCredentialSecretId !== row.imapCredentialSecretId,
      smtp: next.smtpCredentialSecretId !== row.smtpCredentialSecretId,
    });
    const now = nowOf();
    await db
      .update(mailAccounts)
      .set({
        ...next,
        // A changed IMAP connection starts fresh: the old UID cursor belongs
        // to a different mailbox (or different credential) and could skip
        // mail or re-fetch the wrong range.
        ...(imapChanged ? { lastSeenUid: null, consecutiveFailures: 0, lastCheckOk: null, lastCheckMessage: null } : {}),
        ...((next.enabled && !row.enabled) || imapChanged ? { nextCheckAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(mailAccounts.id, row.id), eq(mailAccounts.companyId, companyId)));
    if (next.imapCredentialSecretId !== row.imapCredentialSecretId || next.smtpCredentialSecretId !== row.smtpCredentialSecretId || next.displayName !== row.displayName) {
      await syncCredentialBindings(companyId, row.id, next.displayName, next.imapCredentialSecretId, next.smtpCredentialSecretId);
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "mail_account.updated",
      entityType: "mail_account",
      entityId: row.id,
      details: { changed: Object.keys(patch) },
    });
    return getAccount(companyId, row.id, actor);
  }

  async function removeAccount(companyId: string, accountId: string, actor: MailAccountActor): Promise<void> {
    const row = await getAccountRow(companyId, accountId);
    assertConfigAccess(actor, row);
    await db.delete(mailAccounts).where(and(eq(mailAccounts.id, row.id), eq(mailAccounts.companyId, companyId)));
    await secrets
      .syncSecretRefsForTarget(companyId, { targetType: "mail_account", targetId: row.id }, [], { replaceAll: true })
      .catch((err) => logger.warn({ err, companyId }, "mail-accounts: could not remove a deleted account's credential bindings"));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "mail_account.deleted",
      entityType: "mail_account",
      entityId: row.id,
      details: { displayName: row.displayName },
    });
  }

  // ─── Reading messages (inbox / search / one message) ──────────────────────

  function normalizeLimit(limit: number | undefined): number {
    return Math.min(Math.max(limit ?? MAIL_LIST_DEFAULT_LIMIT, 1), MAIL_LIST_MAX_LIMIT);
  }

  async function listMessagesUnchecked(
    accountId: string,
    opts: { folder?: MailMessageFolder; q?: string; limit?: number },
  ): Promise<MailMessageSummary[]> {
    const conditions = [eq(mailMessages.accountId, accountId)];
    if (opts.folder) conditions.push(eq(mailMessages.folder, opts.folder));
    if (opts.q && opts.q.trim()) {
      const needle = `%${opts.q.trim()}%`;
      conditions.push(
        or(
          ilike(mailMessages.subject, needle),
          ilike(mailMessages.bodyText, needle),
          ilike(mailMessages.fromAddress, needle),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(mailMessages)
      .where(and(...conditions))
      .orderBy(desc(mailMessages.createdAt))
      .limit(normalizeLimit(opts.limit));
    return rows.map(toMessageSummary);
  }

  async function listMessages(
    companyId: string,
    accountId: string,
    actor: MailAccountActor,
    opts: { folder?: MailMessageFolder; limit?: number } = {},
  ): Promise<MailMessageSummary[]> {
    const row = await getAccountRow(companyId, accountId);
    assertContentAccess(actor, row);
    return listMessagesUnchecked(accountId, opts);
  }

  async function searchMessages(
    companyId: string,
    accountId: string,
    actor: MailAccountActor,
    opts: { q: string; folder?: MailMessageFolder; limit?: number },
  ): Promise<MailMessageSummary[]> {
    const row = await getAccountRow(companyId, accountId);
    assertContentAccess(actor, row);
    return listMessagesUnchecked(accountId, opts);
  }

  async function getMessageRow(companyId: string, accountId: string, messageId: string): Promise<MailMessageRow> {
    const [row] = await db
      .select()
      .from(mailMessages)
      .where(and(eq(mailMessages.id, messageId), eq(mailMessages.accountId, accountId), eq(mailMessages.companyId, companyId)));
    if (!row) throw notFound("Message not found");
    return row;
  }

  async function getMessage(
    companyId: string,
    accountId: string,
    messageId: string,
    actor: MailAccountActor,
  ): Promise<MailMessageSummary> {
    const accountRow = await getAccountRow(companyId, accountId);
    assertContentAccess(actor, accountRow);
    const row = await getMessageRow(companyId, accountId, messageId);
    if (!row.isRead && row.direction === "inbound") {
      await db.update(mailMessages).set({ isRead: true, updatedAt: nowOf() }).where(eq(mailMessages.id, row.id));
      row.isRead = true;
    }
    return toMessageSummary(row);
  }

  /**
   * Owner/admin break-glass read, per the ticket's "no admin snooping except
   * emergency-logged access" requirement. Always writes a private_access_events
   * row (targetKind "mail_account", targetUserId = the owner) before
   * returning anything -- there is no way to read someone else's mailbox
   * content through this file without that row existing first.
   */
  async function emergencyReadMessages(
    companyId: string,
    accountId: string,
    accessedByUserId: string,
    reason: string,
    opts: { folder?: MailMessageFolder; limit?: number; notify?: boolean } = {},
  ): Promise<{ event: unknown; messages: MailMessageSummary[] }> {
    const row = await getAccountRow(companyId, accountId);
    const event = await privateAccess.recordAccess({
      companyId,
      targetUserId: row.ownerUserId,
      accessedByUserId,
      targetKind: "mail_account",
      targetId: accountId,
      reason,
      notify: opts.notify,
    });
    const messages = await listMessagesUnchecked(accountId, opts);
    return { event, messages };
  }

  // ─── Move / archive ────────────────────────────────────────────────────────

  async function moveMessage(
    companyId: string,
    accountId: string,
    messageId: string,
    folder: MailMessageFolder,
    actor: MailAccountActor,
  ): Promise<MailMessageSummary> {
    const accountRow = await getAccountRow(companyId, accountId);
    assertContentAccess(actor, accountRow);
    const row = await getMessageRow(companyId, accountId, messageId);
    if (row.isDraft && folder !== "drafts" && folder !== "trash") {
      throw unprocessable("Send or delete a draft instead of moving it out of Drafts.");
    }
    const now = nowOf();
    await db.update(mailMessages).set({ folder, updatedAt: now }).where(eq(mailMessages.id, row.id));
    await logActivity(db, {
      companyId,
      actorType: actor.type === "agent" ? "agent" : "user",
      actorId: actor.type === "agent" ? (actor.agentId ?? "unknown") : (actor.userId ?? "board"),
      action: "mail_message.moved",
      entityType: "mail_message",
      entityId: row.id,
      agentId: actor.type === "agent" ? (actor.agentId ?? undefined) : undefined,
      details: { accountId, fromFolder: row.folder, toFolder: folder },
    });
    return { ...toMessageSummary(row), folder };
  }

  async function archiveMessage(
    companyId: string,
    accountId: string,
    messageId: string,
    actor: MailAccountActor,
  ): Promise<MailMessageSummary> {
    return moveMessage(companyId, accountId, messageId, "archive", actor);
  }

  // ─── Compose / drafts ──────────────────────────────────────────────────────

  async function createDraft(
    companyId: string,
    accountId: string,
    input: ComposeMailDraftInput,
    actor: MailAccountActor,
  ): Promise<MailMessageSummary> {
    const accountRow = await getAccountRow(companyId, accountId);
    assertContentAccess(actor, accountRow);
    // `input.inReplyToMessageId` is the UUID of the row being replied to (our
    // own primary key, so the client can reference a message it already has);
    // what belongs in the stored/sent In-Reply-To is that row's real RFC
    // Message-ID (the same field inbound sync populates from the IMAP
    // envelope -- see mail-account-imap-client.ts). Resolve one into the
    // other here so sendDraft can hand the SMTP client an actual message id
    // instead of our internal UUID, which a real mail client cannot thread.
    const inReplyToMessageId = input.inReplyToMessageId
      ? (await getMessageRow(companyId, accountId, input.inReplyToMessageId)).messageId
      : null;
    const now = nowOf();
    const [row] = await db
      .insert(mailMessages)
      .values({
        companyId,
        accountId,
        folder: "drafts",
        direction: "outbound",
        inReplyToMessageId,
        fromAddress: accountRow.emailAddress,
        toAddresses: input.toAddresses,
        ccAddresses: input.ccAddresses,
        subject: input.subject,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml,
        isDraft: true,
        // A PA agent's own draft is always flagged AI-drafted regardless of
        // what the body sends; a board actor's input.aiDrafted is honoured
        // as-is (e.g. the UI marking a draft it generated via a model call
        // the human then asked for).
        aiDrafted: actor.type === "agent" ? true : input.aiDrafted,
        draftEditedByUserId: actor.type === "board" ? actor.userId : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Mail draft insert returned no row");
    await logActivity(db, {
      companyId,
      actorType: actor.type === "agent" ? "agent" : "user",
      actorId: actor.type === "agent" ? (actor.agentId ?? "unknown") : (actor.userId ?? "board"),
      action: "mail_draft.created",
      entityType: "mail_message",
      entityId: row.id,
      agentId: actor.type === "agent" ? (actor.agentId ?? undefined) : undefined,
      details: { accountId, aiDrafted: row.aiDrafted },
    });
    return toMessageSummary(row);
  }

  async function updateDraft(
    companyId: string,
    accountId: string,
    draftId: string,
    patch: UpdateMailDraftInput,
    actor: MailAccountActor,
  ): Promise<MailMessageSummary> {
    const accountRow = await getAccountRow(companyId, accountId);
    assertContentAccess(actor, accountRow);
    const row = await getMessageRow(companyId, accountId, draftId);
    if (!row.isDraft) throw unprocessable("That message has already been sent and can no longer be edited.");
    const now = nowOf();
    await db
      .update(mailMessages)
      .set({
        toAddresses: patch.toAddresses ?? row.toAddresses,
        ccAddresses: patch.ccAddresses ?? row.ccAddresses,
        subject: patch.subject ?? row.subject,
        bodyText: patch.bodyText ?? row.bodyText,
        bodyHtml: patch.bodyHtml !== undefined ? patch.bodyHtml : row.bodyHtml,
        aiDrafted: patch.aiDrafted ?? (actor.type === "agent" ? true : row.aiDrafted),
        draftEditedByUserId: actor.type === "board" ? actor.userId : row.draftEditedByUserId,
        updatedAt: now,
      })
      .where(eq(mailMessages.id, row.id));
    return getMessage(companyId, accountId, draftId, actor);
  }

  async function removeDraft(companyId: string, accountId: string, draftId: string, actor: MailAccountActor): Promise<void> {
    const accountRow = await getAccountRow(companyId, accountId);
    assertContentAccess(actor, accountRow);
    const row = await getMessageRow(companyId, accountId, draftId);
    if (!row.isDraft) throw unprocessable("That message has already been sent and can no longer be deleted as a draft.");
    await db.delete(mailMessages).where(eq(mailMessages.id, row.id));
  }

  /**
   * Send a draft over SMTP. This is the one action in the whole feature an
   * AI PA agent may never take -- "the PA/secretary only drafts, a human
   * presses Send" (DUR-4149). Enforced by actor identity, not convention:
   * `actor.type` must be "board" and `actor.userId` must equal the account's
   * own ownerUserId. A company owner/admin who is not the owner cannot send
   * either, even with isCompanyOwnerOrAdmin set -- sending as someone else
   * is identity forgery, and emergency access is for reading, never for
   * acting as the person being read.
   */
  async function sendDraft(
    companyId: string,
    accountId: string,
    draftId: string,
    actor: MailAccountActor,
  ): Promise<MailMessageSummary> {
    const accountRow = await getAccountRow(companyId, accountId);
    if (!isOwner(actor, accountRow)) {
      throw forbidden("Only this mailbox's owner can send a draft, and only as themselves -- an AI PA agent may draft but never send.");
    }
    const row = await getMessageRow(companyId, accountId, draftId);
    if (!row.isDraft) throw conflict("That message has already been sent.");
    if (!accountRow.smtpCredentialSecretId) {
      throw unprocessable("No SMTP password saved yet for this mailbox. Add one in Secrets and pick it on this account.");
    }

    const password = await secrets.resolveSecretValue(companyId, accountRow.smtpCredentialSecretId, "latest", {
      consumerType: "mail_account",
      consumerId: accountRow.id,
      configPath: MAIL_ACCOUNT_SMTP_CREDENTIAL_CONFIG_PATH,
      actorType: "user",
      actorId: actor.userId,
    });

    const sent = await sendMail(
      {
        host: accountRow.smtpHost,
        port: accountRow.smtpPort,
        secure: accountRow.smtpSecure,
        username: accountRow.smtpUsername,
        password,
      },
      {
        from: accountRow.emailAddress,
        to: row.toAddresses,
        cc: row.ccAddresses,
        subject: row.subject,
        text: row.bodyText,
        html: row.bodyHtml,
        inReplyTo: row.inReplyToMessageId,
      },
    );

    const now = nowOf();
    await db
      .update(mailMessages)
      .set({
        isDraft: false,
        folder: "sent",
        messageId: sent.messageId,
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(mailMessages.id, row.id));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "mail_message.sent",
      entityType: "mail_message",
      entityId: row.id,
      details: { accountId, aiDrafted: row.aiDrafted },
    });
    return getMessage(companyId, accountId, draftId, actor);
  }

  // ─── Syncing (IMAP tick) ─────────────────────────────────────────────────────

  async function claimDueAccounts(now: Date): Promise<MailAccountRow[]> {
    const due = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.enabled, true),
          lte(mailAccounts.nextCheckAt, now),
          or(isNull(mailAccounts.checkLeaseUntil), lt(mailAccounts.checkLeaseUntil, now)),
        ),
      )
      .orderBy(asc(mailAccounts.nextCheckAt))
      .limit(MAIL_ACCOUNT_TICK_LIMIT);
    const claimed: MailAccountRow[] = [];
    const leaseUntil = new Date(now.getTime() + MAIL_ACCOUNT_CHECK_LEASE_MS);
    for (const { id } of due) {
      const [row] = await db
        .update(mailAccounts)
        .set({ checkLeaseUntil: leaseUntil })
        .where(and(eq(mailAccounts.id, id), or(isNull(mailAccounts.checkLeaseUntil), lt(mailAccounts.checkLeaseUntil, now))))
        .returning();
      if (row) claimed.push(row);
    }
    return claimed;
  }

  async function resolveImapCredential(row: MailAccountRow): Promise<string | null> {
    if (!row.imapCredentialSecretId) return null;
    return secrets.resolveSecretValue(row.companyId, row.imapCredentialSecretId, "latest", {
      consumerType: "mail_account",
      consumerId: row.id,
      configPath: MAIL_ACCOUNT_IMAP_CREDENTIAL_CONFIG_PATH,
      actorType: "system",
      actorId: null,
    });
  }

  async function recordFailure(row: MailAccountRow, now: Date, message: string): Promise<void> {
    const failures = row.consecutiveFailures + 1;
    const backoffMs = Math.min(row.checkEveryMinutes * 60_000 * 2 ** failures, MAIL_ACCOUNT_MAX_BACKOFF_MS);
    await db
      .update(mailAccounts)
      .set({
        consecutiveFailures: failures,
        lastCheckAt: now,
        lastCheckOk: false,
        lastCheckMessage: message,
        checkLeaseUntil: null,
        nextCheckAt: new Date(now.getTime() + backoffMs),
        updatedAt: now,
      })
      .where(eq(mailAccounts.id, row.id));
  }

  async function insertFetchedMessage(row: MailAccountRow, message: FetchedAccountMailMessage, now: Date): Promise<void> {
    await db
      .insert(mailMessages)
      .values({
        companyId: row.companyId,
        accountId: row.id,
        folder: "inbox",
        direction: "inbound",
        messageUid: message.uid,
        messageId: message.messageId,
        inReplyToMessageId: message.inReplyToMessageId,
        fromAddress: message.from,
        toAddresses: message.to,
        ccAddresses: message.cc,
        subject: message.subject,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml,
        receivedAt: message.receivedAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [mailMessages.accountId, mailMessages.messageUid] });
  }

  async function tickAccount(row: MailAccountRow, now: Date): Promise<MailAccountTickResult> {
    const result: MailAccountTickResult = { checked: 1, fetched: 0, errors: 0 };
    if (!row.imapCredentialSecretId) {
      await recordFailure(row, now, "No IMAP password saved yet. Add one in Secrets and pick it on this account.");
      return result;
    }

    let password: string | null;
    try {
      password = await resolveImapCredential(row);
    } catch (err) {
      await recordFailure(row, now, err instanceof Error ? err.message : "Could not read the saved IMAP password.");
      return result;
    }
    if (!password) {
      await recordFailure(row, now, "No IMAP password saved yet. Add one in Secrets and pick it on this account.");
      return result;
    }

    let messages: FetchedAccountMailMessage[];
    try {
      messages = await fetchMessages(
        {
          host: row.imapHost,
          port: row.imapPort,
          secure: row.imapSecure,
          username: row.imapUsername,
          password,
          mailbox: row.imapMailbox,
        },
        row.lastSeenUid,
        MAIL_ACCOUNT_TICK_BATCH,
      );
    } catch (err) {
      await recordFailure(row, now, err instanceof Error ? err.message : "Could not connect to the mailbox.");
      return result;
    }

    result.fetched = messages.length;
    if (messages.length > 0) {
      for (const message of messages) {
        try {
          await insertFetchedMessage(row, message, now);
        } catch (err) {
          result.errors += 1;
          logger.error({ err, accountId: row.id, uid: message.uid }, "mail-accounts: failed to store a synced message");
        }
      }
      const highestUid = messages.reduce((max, m) => Math.max(max, m.uid), row.lastSeenUid ?? 0);
      await db.update(mailAccounts).set({ lastSeenUid: highestUid }).where(eq(mailAccounts.id, row.id));
    }

    await db
      .update(mailAccounts)
      .set({
        consecutiveFailures: 0,
        lastCheckAt: now,
        lastCheckOk: true,
        lastCheckMessage: null,
        checkLeaseUntil: null,
        nextCheckAt: new Date(now.getTime() + row.checkEveryMinutes * 60_000),
        updatedAt: now,
      })
      .where(eq(mailAccounts.id, row.id));

    return result;
  }

  async function tick(now: Date = nowOf()): Promise<MailAccountTickResult> {
    const claimed = await claimDueAccounts(now);
    const total: MailAccountTickResult = { checked: 0, fetched: 0, errors: 0 };
    for (const row of claimed) {
      try {
        const result = await tickAccount(row, now);
        total.checked += result.checked;
        total.fetched += result.fetched;
        total.errors += result.errors;
      } catch (err) {
        total.errors += 1;
        logger.error({ err, accountId: row.id }, "mail-accounts: tick failed for an account");
        await db
          .update(mailAccounts)
          .set({ checkLeaseUntil: null })
          .where(eq(mailAccounts.id, row.id))
          .catch(() => undefined);
      }
    }
    return total;
  }

  return {
    listMyAccounts,
    listAllAccounts,
    getAccount,
    createAccount,
    updateAccount,
    removeAccount,
    listMessages,
    searchMessages,
    getMessage,
    emergencyReadMessages,
    moveMessage,
    archiveMessage,
    createDraft,
    updateDraft,
    removeDraft,
    sendDraft,
    tick,
  };
}

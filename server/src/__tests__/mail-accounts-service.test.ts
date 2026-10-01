import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, mailMessages, privateAccessEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";
import { mailAccountsService, type MailAccountActor, type MailAccountServiceDeps } from "../services/mail-accounts.ts";
import type { FetchedAccountMailMessage } from "../services/mail-account-imap-client.ts";

/**
 * The per-person mail account service against a real Postgres with every
 * migration applied. IMAP fetch and SMTP send are both faked (deps.fetchMessages
 * / deps.sendMail) -- no real mailbox, no real network call -- so these tests
 * exercise exactly what the ticket's security requirement asks for: the
 * owner/PA-agent/emergency-access content boundary, that sendDraft can never
 * be reached by an agent or a non-owner, and that config access is separate
 * from content access.
 */

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping mail accounts service tests: ${support.reason ?? "unsupported environment"}`);
}

const T0 = new Date("2026-09-29T08:00:00.000Z");

function fetchedMessage(overrides: Partial<FetchedAccountMailMessage> = {}): FetchedAccountMailMessage {
  return {
    uid: 1,
    messageId: "<abc@example.com>",
    inReplyToMessageId: null,
    from: "sender@example.com",
    to: ["owner@example.com"],
    cc: [],
    subject: "Hello",
    receivedAt: T0,
    bodyText: "Hello there.",
    bodyHtml: null,
    ...overrides,
  };
}

d("mail accounts", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-mail-accounts-${randomUUID()}`);

  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("mail_accounts");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Mail Co",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const created = await agentService(db).create(companyId, {
      name,
      role: "general",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    return created.id;
  }

  async function seedSecret(companyId: string, value: string) {
    const secret = await secretService(db).create(companyId, { name: `Mailbox password ${randomUUID()}`, provider: "local_encrypted", value });
    return secret.id;
  }

  function service(overrides: Partial<MailAccountServiceDeps> = {}) {
    return mailAccountsService(db, { now: () => T0, ...overrides });
  }

  function boardActor(userId: string, isCompanyOwnerOrAdmin = false): MailAccountActor {
    return { type: "board", userId, agentId: null, isCompanyOwnerOrAdmin };
  }

  function agentActor(agentId: string): MailAccountActor {
    return { type: "agent", userId: null, agentId, isCompanyOwnerOrAdmin: false };
  }

  async function makeAccount(
    companyId: string,
    ownerUserId: string,
    opts: { paAgentId?: string | null; imapSecretId?: string | null; smtpSecretId?: string | null } = {},
  ) {
    const imapCredentialSecretId = opts.imapSecretId !== undefined ? opts.imapSecretId : await seedSecret(companyId, "imap-pass");
    const smtpCredentialSecretId = opts.smtpSecretId !== undefined ? opts.smtpSecretId : await seedSecret(companyId, "smtp-pass");
    return service().createAccount(
      companyId,
      {
        ownerUserId,
        paAgentId: opts.paAgentId ?? null,
        displayName: "Owner's inbox",
        emailAddress: "owner@example.com",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "owner@example.com",
        imapMailbox: "INBOX",
        imapCredentialSecretId,
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpSecure: true,
        smtpUsername: "owner@example.com",
        smtpCredentialSecretId,
        enabled: true,
        checkEveryMinutes: 5,
      } as never,
      boardActor(ownerUserId),
    );
  }

  describe("content access boundary (owner / PA agent / nobody else)", () => {
    it("lets the owner read their own messages", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const messages = await service().listMessages(companyId, account.id, boardActor("owner-1"));
      expect(messages).toEqual([]);
    });

    it("lets the account's PA agent read messages as itself", async () => {
      const companyId = await seedCompany();
      const paAgentId = await seedAgent(companyId, "Secretary");
      const account = await makeAccount(companyId, "owner-1", { paAgentId });
      await expect(service().listMessages(companyId, account.id, agentActor(paAgentId))).resolves.toEqual([]);
    });

    it("refuses a different board user, even a company owner/admin, without emergency access", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      await expect(service().listMessages(companyId, account.id, boardActor("someone-else"))).rejects.toThrow(/belongs to someone else/);
      await expect(
        service().listMessages(companyId, account.id, boardActor("admin-1", true)),
      ).rejects.toThrow(/belongs to someone else/);
    });

    it("refuses an agent that is not this account's PA", async () => {
      const companyId = await seedCompany();
      const otherAgentId = await seedAgent(companyId, "Not the PA");
      const account = await makeAccount(companyId, "owner-1");
      await expect(service().listMessages(companyId, account.id, agentActor(otherAgentId))).rejects.toThrow(/belongs to someone else/);
    });

    it("emergency access always writes a reasoned private_access_events row before returning content", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const { event, messages } = await service().emergencyReadMessages(companyId, account.id, "admin-1", "Investigating a compliance complaint.");
      expect(messages).toEqual([]);
      const rows = await db.select().from(privateAccessEvents).where(eq(privateAccessEvents.targetId, account.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.targetKind).toBe("mail_account");
      expect(rows[0]?.targetUserId).toBe("owner-1");
      expect(rows[0]?.accessedByUserId).toBe("admin-1");
      expect((event as { id: string }).id).toBe(rows[0]?.id);
    });
  });

  describe("config access boundary (owner or company owner/admin)", () => {
    it("lets a company owner/admin set up an account on the owner's behalf", async () => {
      const companyId = await seedCompany();
      const imapSecretId = await seedSecret(companyId, "imap-pass");
      const smtpSecretId = await seedSecret(companyId, "smtp-pass");
      await expect(
        service().createAccount(
          companyId,
          {
            ownerUserId: "owner-1",
            paAgentId: null,
            displayName: "Owner's inbox",
            emailAddress: "owner@example.com",
            imapHost: "imap.example.com",
            imapPort: 993,
            imapSecure: true,
            imapUsername: "owner@example.com",
            imapMailbox: "INBOX",
            imapCredentialSecretId: imapSecretId,
            smtpHost: "smtp.example.com",
            smtpPort: 587,
            smtpSecure: true,
            smtpUsername: "owner@example.com",
            smtpCredentialSecretId: smtpSecretId,
            enabled: true,
            checkEveryMinutes: 5,
          } as never,
          boardActor("admin-1", true),
        ),
      ).resolves.toMatchObject({ ownerUserId: "owner-1" });
    });

    it("refuses a board user who is neither the intended owner nor a company owner/admin", async () => {
      const companyId = await seedCompany();
      const imapSecretId = await seedSecret(companyId, "imap-pass");
      const smtpSecretId = await seedSecret(companyId, "smtp-pass");
      await expect(
        service().createAccount(
          companyId,
          {
            ownerUserId: "owner-1",
            paAgentId: null,
            displayName: "Owner's inbox",
            emailAddress: "owner@example.com",
            imapHost: "imap.example.com",
            imapPort: 993,
            imapSecure: true,
            imapUsername: "owner@example.com",
            imapMailbox: "INBOX",
            imapCredentialSecretId: imapSecretId,
            smtpHost: "smtp.example.com",
            smtpPort: 587,
            smtpSecure: true,
            smtpUsername: "owner@example.com",
            smtpCredentialSecretId: smtpSecretId,
            enabled: true,
            checkEveryMinutes: 5,
          } as never,
          boardActor("not-owner-or-admin"),
        ),
      ).rejects.toThrow(/owner, or a company owner\/admin/);
    });

    it("rolls back the account if the credential binding fails (e.g. a secret from another company)", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const foreignSecretId = await seedSecret(otherCompanyId, "not-ours");
      await expect(makeAccount(companyId, "owner-1", { imapSecretId: foreignSecretId })).rejects.toThrow();
      const rows = await db.select().from(mailMessages);
      expect(rows).toHaveLength(0);
    });

    it("refuses an admin's IMAP host/port repoint on an already-bound account, instead of silently pointing the owner's real password at it", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      await expect(
        service().updateAccount(
          companyId,
          account.id,
          { imapHost: "evil.attacker.example", imapPort: 993 } as never,
          boardActor("admin-1", true),
        ),
      ).rejects.toThrow(/requires the mailbox owner|clearing\/replacing the credential/);
      const unchanged = await service().getAccount(companyId, account.id, boardActor("owner-1"));
      expect(unchanged).toMatchObject({ imapHost: "imap.example.com", imapPort: 993 });
    });

    it("refuses an admin's SMTP host/port repoint on an already-bound account", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      await expect(
        service().updateAccount(
          companyId,
          account.id,
          { smtpHost: "evil.attacker.example", smtpPort: 587 } as never,
          boardActor("admin-1", true),
        ),
      ).rejects.toThrow(/requires the mailbox owner|clearing\/replacing the credential/);
    });

    it("lets an admin repoint the IMAP host if the credential is cleared/replaced in the same change", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      await expect(
        service().updateAccount(
          companyId,
          account.id,
          { imapHost: "new-host.example.com", imapPort: 993, imapCredentialSecretId: null } as never,
          boardActor("admin-1", true),
        ),
      ).resolves.toMatchObject({ imapHost: "new-host.example.com", hasImapCredential: false });
    });

    it("still lets the owner themself repoint their own IMAP host/port", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      await expect(
        service().updateAccount(
          companyId,
          account.id,
          { imapHost: "new-host.example.com", imapPort: 993 } as never,
          boardActor("owner-1"),
        ),
      ).resolves.toMatchObject({ imapHost: "new-host.example.com" });
    });
  });

  describe("sendDraft: owner-as-board-actor only, never an agent", () => {
    it("refuses an agent credential even if it is the account's own PA agent", async () => {
      const companyId = await seedCompany();
      const paAgentId = await seedAgent(companyId, "Secretary");
      const account = await makeAccount(companyId, "owner-1", { paAgentId });
      const draft = await service().createDraft(
        companyId,
        account.id,
        { toAddresses: ["someone@example.com"], ccAddresses: [], subject: "Hi", bodyText: "Hi", bodyHtml: null, inReplyToMessageId: null, aiDrafted: true } as never,
        agentActor(paAgentId),
      );
      await expect(service().sendDraft(companyId, account.id, draft.id, agentActor(paAgentId))).rejects.toThrow(/never send/);
    });

    it("refuses a company owner/admin who is not the mailbox owner", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const draft = await service().createDraft(
        companyId,
        account.id,
        { toAddresses: ["someone@example.com"], ccAddresses: [], subject: "Hi", bodyText: "Hi", bodyHtml: null, inReplyToMessageId: null, aiDrafted: false } as never,
        boardActor("owner-1"),
      );
      await expect(service().sendDraft(companyId, account.id, draft.id, boardActor("admin-1", true))).rejects.toThrow(/never send/);
    });

    it("lets the owner send, resolving the SMTP password and marking the draft sent", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const draft = await service().createDraft(
        companyId,
        account.id,
        { toAddresses: ["someone@example.com"], ccAddresses: [], subject: "Hi", bodyText: "Hi", bodyHtml: null, inReplyToMessageId: null, aiDrafted: false } as never,
        boardActor("owner-1"),
      );
      const sendMail = vi.fn(async () => ({ messageId: "<sent@example.com>" }));
      const sent = await service({ sendMail }).sendDraft(companyId, account.id, draft.id, boardActor("owner-1"));
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sent.isDraft).toBe(false);
      expect(sent.folder).toBe("sent");
    });
  });

  describe("reply threading", () => {
    it("resolves a draft's inReplyToMessageId (our row id) to the original message's real RFC Message-ID before storing/sending", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const fetchMessages = vi.fn(async () => [fetchedMessage({ messageId: "<original@example.com>" })]);
      await service({ fetchMessages }).tick(T0);
      const [original] = await service().listMessages(companyId, account.id, boardActor("owner-1"));
      expect(original?.messageId).toBe("<original@example.com>");

      const draft = await service().createDraft(
        companyId,
        account.id,
        {
          toAddresses: ["sender@example.com"],
          ccAddresses: [],
          subject: "Re: Hello",
          bodyText: "Thanks!",
          bodyHtml: null,
          inReplyToMessageId: original!.id,
          aiDrafted: false,
        } as never,
        boardActor("owner-1"),
      );
      expect(draft.inReplyToMessageId).toBe("<original@example.com>");

      const sendMail = vi.fn(async () => ({ messageId: "<reply@example.com>" }));
      await service({ sendMail }).sendDraft(companyId, account.id, draft.id, boardActor("owner-1"));
      expect(sendMail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inReplyTo: "<original@example.com>" }),
      );
    });
  });

  describe("move/archive", () => {
    it("refuses to move a draft anywhere except drafts or trash", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const draft = await service().createDraft(
        companyId,
        account.id,
        { toAddresses: ["someone@example.com"], ccAddresses: [], subject: "Hi", bodyText: "Hi", bodyHtml: null, inReplyToMessageId: null, aiDrafted: false } as never,
        boardActor("owner-1"),
      );
      await expect(service().archiveMessage(companyId, account.id, draft.id, boardActor("owner-1"))).rejects.toThrow(/Send or delete a draft/);
    });
  });

  // `tick` claims every due account globally (it is the scheduler's
  // entrypoint, not scoped to one company), and other describe blocks above
  // create accounts of their own at the same frozen T0 that never get
  // ticked -- so these assertions key off this test's own account/company
  // rather than the batch totals, which can include unrelated due accounts
  // from earlier tests sharing this embedded database.
  describe("sync tick", () => {
    it("fetches new messages for a due, enabled account and advances its cursor", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const fetchMessages = vi.fn(async () => [fetchedMessage({ uid: 5 }), fetchedMessage({ uid: 7, messageId: "<second@example.com>" })]);
      const result = await service({ fetchMessages }).tick(T0);
      expect(result.errors).toBe(0);
      expect(fetchMessages).toHaveBeenCalledWith(expect.objectContaining({ host: "imap.example.com" }), null, expect.any(Number));
      const messages = await service().listMessages(companyId, account.id, boardActor("owner-1"));
      expect(messages).toHaveLength(2);
    });

    it("records a failure and backs off without throwing when IMAP fetch fails", async () => {
      const companyId = await seedCompany();
      const account = await makeAccount(companyId, "owner-1");
      const fetchMessages = vi.fn(async () => {
        throw new Error("connection refused");
      });
      const result = await service({ fetchMessages }).tick(T0);
      expect(result.errors).toBe(0);
      const updated = await service().getAccount(companyId, account.id, boardActor("owner-1"));
      expect(updated.lastCheckOk).toBe(false);
      expect(updated.consecutiveFailures).toBe(1);
      expect(updated.lastCheckMessage).toContain("connection refused");
    });
  });
});

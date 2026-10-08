import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  mailMessageClassifications,
  mailMessages,
  mailUrgencyAlerts,
} from "@paperclipai/db";
import { isMailUrgencyHandled, isMailUrgencyIgnored, type MailUrgencyClassification } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.ts";
import { mailAccountsService, type MailAccountActor } from "../services/mail-accounts.ts";
import type { FetchedAccountMailMessage } from "../services/mail-account-imap-client.ts";
import { buildMailUrgencyAlertText } from "../services/mail-urgency.ts";
import { parseMailUrgency } from "../services/mail-urgency-classifier.ts";

const T0 = new Date("2026-10-06T08:00:00.000Z");

describe("urgency recipient filter (pure, before any model call)", () => {
  it("handles filipdurkan@gmail.com and any @durkanagency.com address", () => {
    expect(isMailUrgencyHandled(["Filip <FilipDurkan@gmail.com>"])).toBe(true);
    expect(isMailUrgencyHandled(["maja@durkanagency.com"])).toBe(true);
  });
  it("handled-only, ignored-only, both, neither", () => {
    expect(isMailUrgencyHandled(["filipdurkan@gmail.com"])).toBe(true);
    expect(isMailUrgencyHandled(["post@nordstrandgruppen.no", "x@nordstrandmobler.no"])).toBe(false);
    expect(isMailUrgencyIgnored(["post@nordstrandgruppen.no"])).toBe(true);
    // both -> handled wins
    expect(isMailUrgencyHandled(["post@nordstrandgruppen.no", "filipdurkan@gmail.com"])).toBe(true);
    // neither -> not handled
    expect(isMailUrgencyHandled(["someone@example.com"])).toBe(false);
    expect(isMailUrgencyHandled([])).toBe(false);
  });
  it("does not match look-alike domains", () => {
    expect(isMailUrgencyHandled(["a@evil-durkanagency.com", "a@durkanagency.com.evil.io"])).toBe(false);
  });
});

describe("urgency classifier output mapping", () => {
  it("maps a well-formed urgent result", () => {
    const { classification, fallback } = parseMailUrgency(
      '{"urgent":true,"reason":"Payment due today.","category":"bank-payment","summary":"Invoice due","draftReply":null}',
    );
    expect(fallback).toBe(false);
    expect(classification).toMatchObject({ urgent: true, category: "bank-payment", summary: "Invoice due", draftReply: null });
  });
  it("never resolves malformed output to non-urgent", () => {
    for (const bad of [
      "no json here",
      "{not json}",
      '{"urgent":"yes","reason":"r","category":"other","summary":"s"}',
      '{"urgent":false,"reason":"r","category":"made-up","summary":"s"}',
      '{"urgent":false,"reason":"","category":"other","summary":"s"}',
    ]) {
      const { classification, fallback } = parseMailUrgency(bad);
      expect(fallback).toBe(true);
      expect(classification.urgent).toBe(true);
    }
  });
  it("alert text has sender, subject, summary, reason -- one line each, no body", () => {
    const text = buildMailUrgencyAlertText({
      from: "a@b.c",
      subject: "Hi\nthere",
      summary: "Summary",
      reason: "Reason",
      link: "https://x/y",
    });
    expect(text).toContain("Subject: Hi there");
    expect(text).toContain("https://x/y");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping mail urgency DB tests: ${support.reason ?? "unsupported environment"}`);

d("mail urgency pipeline", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmp = path.join(os.tmpdir(), `paperclip-mail-urgency-${randomUUID()}`);
  vi.setConfig({ testTimeout: 60_000 });

  beforeAll(async () => {
    mkdirSync(tmp, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmp, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("mail_urgency");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 90_000);

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(tmp, { recursive: true, force: true });
  });

  const owner: MailAccountActor = { type: "board", userId: "filip", agentId: null, isCompanyOwnerOrAdmin: false };
  const agentActor = (agentId: string): MailAccountActor => ({ type: "agent", userId: null, agentId, isCompanyOwnerOrAdmin: false });

  function verdict(over: Partial<MailUrgencyClassification> = {}): { classification: MailUrgencyClassification; fallback: boolean } {
    return {
      fallback: false,
      classification: { urgent: true, reason: "Needs Filip today.", category: "person", summary: "A person is waiting", draftReply: null, ...over },
    };
  }

  async function setup(emailAddress = "filipdurkan@gmail.com", withPa = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Urgency Co",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const paAgentId = withPa
      ? (
          await agentService(db).create(companyId, {
            name: "Secretary",
            role: "general",
            status: "active",
            adapterType: "claude_local",
            adapterConfig: {},
            runtimeConfig: {},
            spentMonthlyCents: 0,
            lastHeartbeatAt: null,
          })
        ).id
      : null;
    const secret = await secretService(db).create(companyId, { name: `pw ${randomUUID()}`, provider: "local_encrypted", value: "pw" });
    const username = `u-${randomUUID()}@example.com`;
    const classify = vi.fn(async () => verdict());
    const fetchBox: { messages: FetchedAccountMailMessage[] } = { messages: [] };
    const svc = mailAccountsService(db, {
      now: () => T0,
      urgencyClassifier: { classify },
      fetchMessages: async (config) => (config.username === username ? fetchBox.messages : []),
    });
    const account = await svc.createAccount(
      companyId,
      {
        ownerUserId: "filip",
        paAgentId,
        displayName: "Filip",
        emailAddress,
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecure: true,
        imapUsername: username,
        imapMailbox: "INBOX",
        imapCredentialSecretId: secret.id,
        smtpHost: "smtp.example.com",
        smtpPort: 587,
        smtpSecure: true,
        smtpUsername: username,
        smtpCredentialSecretId: secret.id,
        enabled: true,
        checkEveryMinutes: 5,
      } as never,
      owner,
    );
    return { companyId, account, svc, classify, fetchBox, paAgentId };
  }

  function msg(over: Partial<FetchedAccountMailMessage> = {}): FetchedAccountMailMessage {
    return {
      uid: 1,
      messageId: `<${randomUUID()}@example.com>`,
      inReplyToMessageId: null,
      from: "sender@example.com",
      to: ["filipdurkan@gmail.com"],
      cc: [],
      subject: "Please call me",
      receivedAt: T0,
      bodyText: "SECRET BODY TEXT",
      bodyHtml: null,
      ...over,
    };
  }

  it("urgent handled mail: one classification, one alert, stable across a retried pass", async () => {
    const { companyId, account, svc, classify, fetchBox } = await setup();
    fetchBox.messages = [msg({ uid: 1 })];
    await svc.tick(T0);
    const [stored] = await db.select().from(mailMessages).where(eq(mailMessages.accountId, account.id));
    expect(classify).toHaveBeenCalledTimes(1);
    // a retried classification pass for the same message
    await mailAccountsService(db, { now: () => T0, urgencyClassifier: { classify } }).tick(T0);
    const classifications = await db.select().from(mailMessageClassifications).where(eq(mailMessageClassifications.messageId, stored!.id));
    expect(classifications).toHaveLength(1);
    expect(classifications[0]).toMatchObject({ urgent: true, category: "person", summary: "A person is waiting" });
    const alerts = await db.select().from(mailUrgencyAlerts).where(eq(mailUrgencyAlerts.messageId, stored!.id));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe("ready");
    expect(alerts[0]!.text).not.toContain("SECRET BODY TEXT");
    expect(alerts[0]!.text).toContain("sender@example.com");

    const outbox = await svc.urgencyOutbox(companyId);
    expect(outbox).toHaveLength(1);
    await svc.urgencyAck(companyId, outbox[0]!.id, { outcome: "delivered" });
    await svc.urgencyAck(companyId, outbox[0]!.id, { outcome: "failed" }); // idempotent: no change
    expect(await svc.urgencyOutbox(companyId)).toHaveLength(0);
    const [acked] = await db.select().from(mailUrgencyAlerts).where(eq(mailUrgencyAlerts.id, outbox[0]!.id));
    expect(acked!.status).toBe("delivered");
  });

  it("outbox names the mailbox's assistant so the bridge sends from her bot", async () => {
    const withPa = await setup("filipdurkan@gmail.com", true);
    withPa.fetchBox.messages = [msg({ uid: 1 })];
    await withPa.svc.tick(T0);
    const outbox = await withPa.svc.urgencyOutbox(withPa.companyId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.agentId).toBe(withPa.paAgentId);
  });

  it("outbox has no assistant when the mailbox has none", async () => {
    const { companyId, svc, fetchBox } = await setup();
    fetchBox.messages = [msg({ uid: 1 })];
    await svc.tick(T0);
    const outbox = await svc.urgencyOutbox(companyId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.agentId).toBeNull();
  });

  it("non-urgent mail produces no alert and no outbox row", async () => {
    const { companyId, account, svc, classify, fetchBox } = await setup();
    classify.mockResolvedValue(verdict({ urgent: false, category: "newsletter" }));
    fetchBox.messages = [msg({ uid: 1 })];
    await svc.tick(T0);
    const [stored] = await db.select().from(mailMessages).where(eq(mailMessages.accountId, account.id));
    const [c] = await db.select().from(mailMessageClassifications).where(eq(mailMessageClassifications.messageId, stored!.id));
    expect(c).toMatchObject({ urgent: false, category: "newsletter" });
    expect(await db.select().from(mailUrgencyAlerts).where(eq(mailUrgencyAlerts.companyId, companyId))).toHaveLength(0);
    expect(await svc.urgencyOutbox(companyId)).toHaveLength(0);
  });

  it("Nordstrand-only mail never reaches the classifier; mixed mail does", async () => {
    const { companyId, svc, classify, fetchBox, account } = await setup();
    fetchBox.messages = [
      msg({ uid: 1, to: ["post@nordstrandgruppen.no"] }),
      msg({ uid: 2, to: ["x@nordstrandmobler.no"], deliveredTo: ["y@nordstrandmobler.no"] }),
      msg({ uid: 3, to: ["someone@example.com"] }),
    ];
    await svc.tick(T0);
    expect(classify).not.toHaveBeenCalled();
    expect(await db.select().from(mailMessageClassifications).where(eq(mailMessageClassifications.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(mailMessages).where(eq(mailMessages.accountId, account.id))).toHaveLength(3);

    fetchBox.messages = [msg({ uid: 4, to: ["post@nordstrandgruppen.no"], cc: ["filipdurkan@gmail.com"] })];
    await svc.tick(new Date(T0.getTime() + 3_600_000));
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("Delivered-To never makes a message handled (Gmail stamps it on everything)", async () => {
    const { companyId, svc, classify, fetchBox } = await setup();
    fetchBox.messages = [
      msg({ uid: 1, to: ["post@nordstrandgruppen.no"], deliveredTo: ["filipdurkan@gmail.com"] }),
      msg({ uid: 2, to: ["list@example.com"], deliveredTo: ["filipdurkan@gmail.com"] }),
    ];
    await svc.tick(T0);
    expect(classify).not.toHaveBeenCalled();
    expect(await db.select().from(mailMessageClassifications).where(eq(mailMessageClassifications.companyId, companyId))).toHaveLength(0);
  });

  it("other mailboxes are never classified", async () => {
    const { svc, classify, fetchBox } = await setup("maja@durkanagency.com");
    fetchBox.messages = [msg({ uid: 1, to: ["maja@durkanagency.com"] })];
    await svc.tick(T0);
    expect(classify).not.toHaveBeenCalled();
  });

  it("a classifier failure is stored as urgent with a generic reason, never dropped", async () => {
    const { account, svc, classify, fetchBox } = await setup();
    classify.mockResolvedValue({ ...parseMailUrgency("garbage") });
    fetchBox.messages = [msg({ uid: 1 })];
    await svc.tick(T0);
    const [stored] = await db.select().from(mailMessages).where(eq(mailMessages.accountId, account.id));
    const [c] = await db.select().from(mailMessageClassifications).where(eq(mailMessageClassifications.messageId, stored!.id));
    expect(c).toMatchObject({ urgent: true, fallback: true });
    expect(await db.select().from(mailUrgencyAlerts).where(eq(mailUrgencyAlerts.messageId, stored!.id))).toHaveLength(1);
  });

  it("writes a never-sent AI draft as the PA agent, and an agent cannot send it", async () => {
    const { companyId, account, svc, classify, fetchBox, paAgentId } = await setup("filipdurkan@gmail.com", true);
    classify.mockResolvedValue(verdict({ draftReply: "Thanks, I will call you today." }));
    fetchBox.messages = [msg({ uid: 1 })];
    await svc.tick(T0);
    const drafts = await db.select().from(mailMessages).where(eq(mailMessages.accountId, account.id));
    const draft = drafts.find((m) => m.isDraft)!;
    expect(draft).toMatchObject({ aiDrafted: true, folder: "drafts", direction: "outbound" });
    expect(draft.toAddresses).toEqual(["sender@example.com"]);
    expect(draft.inReplyToMessageId).toBeTruthy();
    await expect(svc.sendDraft(companyId, account.id, draft.id, agentActor(paAgentId!))).rejects.toThrow(/never send/);
    const still = await db.select().from(mailMessages).where(eq(mailMessages.id, draft.id));
    expect(still[0]!.isDraft).toBe(true);
  });

  it("owner can mark a classification; an agent cannot", async () => {
    const { companyId, account, svc, fetchBox, paAgentId } = await setup("filipdurkan@gmail.com", true);
    fetchBox.messages = [msg({ uid: 1 })];
    await svc.tick(T0);
    const [stored] = await db.select().from(mailMessages).where(eq(mailMessages.accountId, account.id));
    await expect(svc.setUrgencyFeedback(companyId, account.id, stored!.id, "incorrect", agentActor(paAgentId!))).rejects.toThrow();
    const out = await svc.setUrgencyFeedback(companyId, account.id, stored!.id, "incorrect", owner);
    expect(out.operatorFeedback).toBe("incorrect");
    const listed = await svc.listMessages(companyId, account.id, owner);
    expect(listed.find((m) => m.id === stored!.id)?.urgency?.operatorFeedback).toBe("incorrect");
  });
});

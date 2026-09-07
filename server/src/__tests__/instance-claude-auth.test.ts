// One-click Claude sign-in: the instance-wide token service. Uses the real
// embedded Postgres + the real local_encrypted sealing; the Claude CLI
// (verification probe and the setup-token pseudo-terminal) is faked.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, companies, createDb, instanceClaudeAuth } from "@paperclipai/db";
import type {
  ClaudeSignInSession,
  ClaudeSignInSessionSnapshot,
  ClaudeTokenVerification,
  StartClaudeSignInSessionOptions,
} from "@paperclipai/adapter-claude-local/server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  instanceClaudeAuthService,
  resetInstanceClaudeAuthStateForTests,
} from "../services/instance-claude-auth.js";
import { HttpError } from "../errors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres instance Claude auth tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const GOOD_TOKEN = `sk-ant-oat01-${"Good1234".repeat(10)}-AA`;
const OTHER_TOKEN = `sk-ant-oat01-${"Fresh567".repeat(10)}-BB`;
const BAD_TOKEN = `sk-ant-oat01-${"Bad00000".repeat(10)}-CC`;

function okVerification(): ClaudeTokenVerification {
  return { ok: true, authRejected: false, model: "claude-sonnet-5", message: "Claude answered. This token works." };
}

function rejectedVerification(token: string): ClaudeTokenVerification {
  return {
    ok: false,
    authRejected: true,
    model: null,
    message: `Claude rejected this token (401 OAuth access token is invalid ${token}).`,
  };
}

class FakeSignIn implements ClaudeSignInSession {
  private status: ClaudeSignInSessionSnapshot["status"] = "starting";
  private loginUrl: string | null = null;
  private message: string | null = "Starting…";
  private resolveDone!: (snapshot: ClaudeSignInSessionSnapshot) => void;
  readonly done = new Promise<ClaudeSignInSessionSnapshot>((resolve) => {
    this.resolveDone = resolve;
  });
  submitted: string[] = [];
  constructor(private readonly options: StartClaudeSignInSessionOptions) {}
  snapshot(): ClaudeSignInSessionSnapshot {
    return {
      status: this.status,
      loginUrl: this.loginUrl,
      message: this.message,
      startedAt: "2026-09-07T10:00:00.000Z",
      updatedAt: "2026-09-07T10:00:00.000Z",
    };
  }
  showUrl(url: string) {
    this.status = "awaiting_code";
    this.loginUrl = url;
    this.message = "Open the link and paste the code.";
  }
  submitCode(code: string) {
    if (this.status !== "awaiting_code") throw new Error("The sign-in link is not ready yet.");
    this.submitted.push(code);
    this.status = "exchanging";
  }
  async finishWithToken(token: string) {
    try {
      await this.options.onToken(token);
      this.status = "completed";
      this.message = "Signed in.";
    } catch (err) {
      this.status = "failed";
      this.message = err instanceof Error ? err.message : String(err);
    }
    this.resolveDone(this.snapshot());
  }
  cancel(reason?: string) {
    this.status = "cancelled";
    this.message = reason ?? "Sign-in cancelled.";
    this.resolveDone(this.snapshot());
  }
}

describeEmbeddedPostgres("instance Claude auth service", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-instance-claude-auth-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("instance-claude-auth");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    resetInstanceClaudeAuthStateForTests();
    await db.delete(instanceClaudeAuth);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  function makeService(overrides: Partial<Parameters<typeof instanceClaudeAuthService>[1]> = {}) {
    const verifyToken = vi.fn(async (token: string) =>
      token === GOOD_TOKEN || token === OTHER_TOKEN ? okVerification() : rejectedVerification(token),
    );
    const svc = instanceClaudeAuthService(db, {
      verifyToken,
      readCliVersion: async () => "2.1.263 (Claude Code)",
      automaticSupport: () => ({ supported: true, reason: null }),
      ...overrides,
    });
    return { svc, verifyToken };
  }

  it("reports not configured with CLI facts when nothing is saved", async () => {
    const { svc } = makeService();
    const status = await svc.getStatus();
    expect(status.configured).toBe(false);
    expect(status.health).toBe("not_configured");
    expect(status.headline).toMatch(/Not signed in/);
    expect(status.cli).toEqual({ command: "claude", version: "2.1.263 (Claude Code)" });
    expect(status.automaticSignIn.supported).toBe(true);
    expect(status.activeSignIn).toBeNull();
    expect(await svc.resolveFallbackToken()).toBeNull();
  });

  it("tests a pasted token with the CLI, seals it, and never exposes it", async () => {
    const { svc, verifyToken } = makeService();
    const status = await svc.saveToken({ token: `  ${GOOD_TOKEN}\n`, source: "pasted", userId: "user-1" });
    expect(verifyToken).toHaveBeenCalledWith(GOOD_TOKEN);
    expect(status.configured).toBe(true);
    expect(status.health).toBe("ok");
    expect(status.source).toBe("pasted");
    expect(status.savedByUserId).toBe("user-1");
    expect(status.lastCheckOk).toBe(true);
    expect(status.expiresInDays).toBeGreaterThan(300);
    expect(status.fingerprint).toHaveLength(12);
    expect(JSON.stringify(status)).not.toContain(GOOD_TOKEN);

    const [row] = await db.select().from(instanceClaudeAuth);
    expect(row?.tokenSealed.startsWith("instance-claude-auth:")).toBe(true);
    expect(row?.tokenSealed).not.toContain(GOOD_TOKEN);
    expect(await svc.resolveFallbackToken()).toBe(GOOD_TOKEN);
  });

  it("refuses to store a token Claude rejects, with a token-free 422", async () => {
    const { svc } = makeService();
    await expect(svc.saveToken({ token: BAD_TOKEN, source: "pasted", userId: null })).rejects.toMatchObject({
      status: 422,
    });
    try {
      await svc.saveToken({ token: BAD_TOKEN, source: "pasted", userId: null });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).toMatch(/rejected this token/);
      expect((err as HttpError).message).not.toContain(BAD_TOKEN);
    }
    await expect(svc.saveToken({ token: "not-a-token", source: "pasted", userId: null })).rejects.toMatchObject({
      status: 422,
    });
    expect((await svc.getStatus()).configured).toBe(false);
  });

  it("rotates in place when a new token is saved and reports it as a different fingerprint", async () => {
    const { svc } = makeService();
    const first = await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
    const second = await svc.saveToken({ token: OTHER_TOKEN, source: "pasted", userId: null });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const rows = await db.select().from(instanceClaudeAuth);
    expect(rows).toHaveLength(1);
    expect(await svc.resolveFallbackToken()).toBe(OTHER_TOKEN);
  });

  it("check now re-tests the stored token and flips health when Claude starts rejecting it", async () => {
    let accept = true;
    const { svc } = makeService({
      verifyToken: async (token) => (accept ? okVerification() : rejectedVerification(token)),
    });
    await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
    accept = false;
    const failed = await svc.checkNow();
    expect(failed.health).toBe("check_failed");
    expect(failed.lastCheckOk).toBe(false);
    expect(failed.lastCheckMessage).toMatch(/rejected/);
    expect(failed.lastCheckMessage).not.toContain(GOOD_TOKEN);
    expect(failed.headline).toMatch(/Sign in again/);
    accept = true;
    const recovered = await svc.checkNow();
    expect(recovered.health).toBe("ok");
    expect(recovered.lastAuthFailureAt).toBeNull();
  });

  it("a run that was told to log in marks the sign-in as failing until it is re-checked", async () => {
    const { svc } = makeService();
    await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
    await svc.markAuthFailure();
    const status = await svc.getStatus();
    expect(status.health).toBe("check_failed");
    expect(status.lastAuthFailureAt).not.toBeNull();
    expect((await svc.checkNow()).health).toBe("ok");
  });

  it("shows expiring soon and expired from the estimated one-year lifetime", async () => {
    const savedAt = new Date("2026-01-01T00:00:00.000Z");
    let current = savedAt;
    const { svc } = makeService({ now: () => current });
    await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
    current = new Date(savedAt.getTime() + 360 * 24 * 60 * 60 * 1000);
    const soon = await svc.getStatus();
    expect(soon.health).toBe("expiring_soon");
    expect(soon.expiresInDays).toBe(5);
    expect(soon.headline).toMatch(/expires in about 5 days/);
    current = new Date(savedAt.getTime() + 366 * 24 * 60 * 60 * 1000);
    const expired = await svc.getStatus();
    expect(expired.health).toBe("expired");
    expect(expired.headline).toMatch(/expired/);
  });

  it("removing the sign-in stops the fallback", async () => {
    const { svc } = makeService();
    await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
    const status = await svc.clear();
    expect(status.configured).toBe(false);
    expect(await svc.resolveFallbackToken()).toBeNull();
  });

  // Polish round 3: the daily re-check and its operator notice.
  describe("scheduled daily check", () => {
    async function seedCompany(name: string) {
      const id = randomUUID();
      await db.insert(companies).values({
        id,
        name,
        status: "active",
        issuePrefix: `C${id.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        requireBoardApprovalForNewAgents: false,
      });
      return id;
    }

    async function listNotices(companyId: string) {
      return db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "instance_claude_auth")));
    }

    afterEach(async () => {
      await db.delete(activityLog);
      await db.delete(companies);
    });

    it("does nothing when no sign-in is saved", async () => {
      const { svc, verifyToken } = makeService();
      expect(await svc.runScheduledCheck()).toEqual({ outcome: "not_configured", status: null, notice: null });
      expect(verifyToken).not.toHaveBeenCalled();
    });

    it("re-tests the token once a day, and stays quiet while it works", async () => {
      const savedAt = new Date("2026-09-07T08:00:00.000Z");
      let current = savedAt;
      const { svc, verifyToken } = makeService({ now: () => current });
      await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
      const companyId = await seedCompany("Durkan");
      verifyToken.mockClear();

      // Saving already tested the token; an hour later nothing is due.
      current = new Date(savedAt.getTime() + 60 * 60 * 1000);
      const early = await svc.runScheduledCheck();
      expect(early.outcome).toBe("not_due");
      expect(verifyToken).not.toHaveBeenCalled();

      current = new Date(savedAt.getTime() + 25 * 60 * 60 * 1000);
      const due = await svc.runScheduledCheck();
      expect(due.outcome).toBe("checked");
      expect(verifyToken).toHaveBeenCalledTimes(1);
      expect(due.notice).toBeNull();
      expect(due.status?.health).toBe("ok");
      expect(due.status?.lastCheckAt).toBe(current.toISOString());
      expect(await listNotices(companyId)).toHaveLength(0);
    });

    it("tells every company in plain words when the daily check fails, once per day", async () => {
      let accept = true;
      const savedAt = new Date("2026-09-07T08:00:00.000Z");
      let current = savedAt;
      const { svc } = makeService({
        now: () => current,
        verifyToken: async (token) => (accept ? okVerification() : rejectedVerification(token)),
      });
      await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
      const first = await seedCompany("Durkan");
      const second = await seedCompany("Nordstrand");

      accept = false;
      current = new Date(savedAt.getTime() + 25 * 60 * 60 * 1000);
      const failed = await svc.runScheduledCheck();
      expect(failed.outcome).toBe("checked");
      expect(failed.status?.health).toBe("check_failed");
      expect(failed.notice?.action).toBe("instance.claude_auth.check_failed");
      expect(failed.notice?.message).toBe(
        "The daily check of the shared Claude sign-in failed. Claude said: Claude rejected this token (401 OAuth access token is invalid sk-ant-oat01-[redacted]). Sign in again under Settings > Instance settings > Claude sign-in so Claude agents without a token of their own keep working.",
      );
      expect(failed.notice?.message).not.toContain(GOOD_TOKEN);
      expect(failed.outcome === "checked" ? failed.noticedCompanyIds.sort() : []).toEqual([first, second].sort());

      for (const companyId of [first, second]) {
        const notices = await listNotices(companyId);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ actorType: "system", actorId: "claude-auth-check", action: "instance.claude_auth.check_failed", entityId: "default" });
        const details = notices[0]!.details as Record<string, unknown>;
        expect(details.message).toBe(failed.notice?.message);
        expect(details.health).toBe("check_failed");
        expect(JSON.stringify(details)).not.toContain(GOOD_TOKEN);
      }

      // The hourly tick must not repeat the notice until a day has passed.
      current = new Date(current.getTime() + 60 * 60 * 1000);
      expect((await svc.runScheduledCheck()).outcome).toBe("not_due");
      expect(await listNotices(first)).toHaveLength(1);
    });

    it("warns a few days before the estimated expiry, and calls an expired sign-in broken", async () => {
      const savedAt = new Date("2026-01-01T00:00:00.000Z");
      let current = savedAt;
      const { svc } = makeService({ now: () => current });
      await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
      const companyId = await seedCompany("Durkan");

      // 10 days out: the page says "expiring soon", the daily notice stays quiet.
      current = new Date(savedAt.getTime() + 355 * 24 * 60 * 60 * 1000);
      const quiet = await svc.runScheduledCheck();
      expect(quiet.outcome).toBe("checked");
      expect(quiet.status?.health).toBe("expiring_soon");
      expect(quiet.notice).toBeNull();

      current = new Date(savedAt.getTime() + 363 * 24 * 60 * 60 * 1000);
      const soon = await svc.runScheduledCheck();
      expect(soon.notice?.action).toBe("instance.claude_auth.expiring");
      expect(soon.notice?.message).toBe(
        "The shared Claude sign-in expires in about 2 days. Sign in again under Settings > Instance settings > Claude sign-in so Claude agents without a token of their own keep working.",
      );
      expect(await listNotices(companyId)).toHaveLength(1);

      current = new Date(savedAt.getTime() + 366 * 24 * 60 * 60 * 1000);
      const expired = await svc.runScheduledCheck();
      expect(expired.status?.health).toBe("expired");
      expect(expired.notice?.action).toBe("instance.claude_auth.check_failed");
      expect(expired.notice?.message).toMatch(/^The shared Claude sign-in has expired\./);
      expect(await listNotices(companyId)).toHaveLength(2);
    });

    it("records a check that could not run at all as a failed check instead of crashing the tick", async () => {
      const savedAt = new Date("2026-09-07T08:00:00.000Z");
      let current = savedAt;
      let broken = false;
      const { svc } = makeService({
        now: () => current,
        verifyToken: async () => {
          if (broken) throw new Error("spawn claude ENOENT");
          return okVerification();
        },
      });
      await svc.saveToken({ token: GOOD_TOKEN, source: "pasted", userId: null });
      const companyId = await seedCompany("Durkan");
      broken = true;
      current = new Date(savedAt.getTime() + 25 * 60 * 60 * 1000);
      const result = await svc.runScheduledCheck();
      expect(result.outcome).toBe("checked");
      expect(result.status?.health).toBe("check_failed");
      expect(result.status?.lastCheckMessage).toBe("spawn claude ENOENT");
      expect(result.notice?.message).toContain("Claude said: spawn claude ENOENT");
      expect(await listNotices(companyId)).toHaveLength(1);
    });
  });

  it("interactive sign-in: start → link → code → token verified and stored, never exposed", async () => {
    let fake!: FakeSignIn;
    const { svc, verifyToken } = makeService({
      startSignIn: (options) => {
        fake = new FakeSignIn(options);
        return fake;
      },
    });
    const started = svc.startInteractiveSignIn({ userId: "user-1" });
    expect(started.status).toBe("starting");
    expect(() => svc.submitSignInCode(started.id, "early")).toThrow(/not ready/);

    fake.showUrl("https://claude.com/cai/oauth/authorize?x=1");
    const polled = svc.getSignIn(started.id);
    expect(polled.status).toBe("awaiting_code");
    expect(polled.loginUrl).toBe("https://claude.com/cai/oauth/authorize?x=1");
    expect((await svc.getStatus()).activeSignIn?.id).toBe(started.id);

    const exchanging = svc.submitSignInCode(started.id, "code#state");
    expect(exchanging.status).toBe("exchanging");
    expect(fake.submitted).toEqual(["code#state"]);

    await fake.finishWithToken(GOOD_TOKEN);
    expect(verifyToken).toHaveBeenCalledWith(GOOD_TOKEN);
    const finished = svc.getSignIn(started.id);
    expect(finished.status).toBe("completed");
    expect(JSON.stringify(finished)).not.toContain(GOOD_TOKEN);
    const status = await svc.getStatus();
    expect(status.health).toBe("ok");
    expect(status.source).toBe("signin");
    expect(status.savedByUserId).toBe("user-1");
    expect(await svc.resolveFallbackToken()).toBe(GOOD_TOKEN);
  });

  it("interactive sign-in fails cleanly when the captured token does not pass the CLI test", async () => {
    let fake!: FakeSignIn;
    const { svc } = makeService({
      startSignIn: (options) => {
        fake = new FakeSignIn(options);
        return fake;
      },
    });
    const started = svc.startInteractiveSignIn({ userId: null });
    fake.showUrl("https://claude.com/cai/oauth/authorize?x=1");
    svc.submitSignInCode(started.id, "code");
    await fake.finishWithToken(BAD_TOKEN);
    const finished = svc.getSignIn(started.id);
    expect(finished.status).toBe("failed");
    expect(finished.message).toMatch(/rejected/);
    expect(finished.message).not.toContain(BAD_TOKEN);
    expect((await svc.getStatus()).configured).toBe(false);
  });

  it("starting a new sign-in replaces an in-flight one, unknown ids 404, and unsupported hosts get a plain reason", async () => {
    const fakes: FakeSignIn[] = [];
    const { svc } = makeService({
      startSignIn: (options) => {
        const fake = new FakeSignIn(options);
        fakes.push(fake);
        return fake;
      },
    });
    const first = svc.startInteractiveSignIn({ userId: null });
    const second = svc.startInteractiveSignIn({ userId: null });
    expect(fakes[0]?.snapshot().status).toBe("cancelled");
    expect(() => svc.getSignIn(first.id)).toThrow(/no longer available/);
    expect(svc.getSignIn(second.id).status).toBe("starting");
    expect(svc.cancelSignIn(second.id).status).toBe("cancelled");

    const { svc: unsupported } = makeService({
      automaticSupport: () => ({ supported: false, reason: "No 'script' tool here." }),
    });
    expect(() => unsupported.startInteractiveSignIn({ userId: null })).toThrow(/No 'script' tool here/);
    expect((await unsupported.getStatus()).automaticSignIn).toEqual({ supported: false, reason: "No 'script' tool here." });
  });
});

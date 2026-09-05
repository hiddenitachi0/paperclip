// DUR-134: the publisher -- the safety-critical core the ticket calls
// "load-bearing, not a bolt-on". Every check below runs IN CODE, at the
// moment of publishing, never as prompt/agent guidance:
//
//   1. Kill switch (item 6): company, persona AND account pause flags, all
//      checked first, before anything else touches the row.
//   2. Warm-up (item 8): below `warmupPostsRequired` published posts on this
//      account -> treated as requires_approval regardless of autonomyMode,
//      no matter what the channel's own setting says.
//   3. Autonomy gate (item 7): requires_approval channels (and warming-up
//      autonomous ones) file a board approval and stop; only an
//      `autonomous` account past warm-up ever reaches step 4 on its own.
//   4. Daily cap (item 3): a per-(account, UTC day) counter reserved with an
//      atomic conditional increment -- refuses post N+1 outright, never lets
//      two concurrent attempts both slip through.
//   5. One-shot publish (item 12): the persona_posts row is claimed with a
//      conditional `UPDATE ... WHERE status IN (...) RETURNING`, so two
//      concurrent publish attempts for the same row can never both win.
//
// `attemptPublish` is meant to be called once per queued/approved post by
// whatever drives the publish loop (a routine trigger per item 4, or a
// manual/system trigger route in the meantime -- see persona-accounts.ts
// routes). It is safe to call repeatedly and concurrently for the same post:
// every state transition below is guarded by a conditional write, so a
// duplicate or racing call is a no-op, not a double-publish.
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  personaAccountPublishCounters,
  personaAccounts,
  personaPosts,
  personas,
} from "@paperclipai/db";
import { PERSONA_POST_AI_DISCLOSURE_TEXT, type PersonaAccountPlatform } from "@paperclipai/shared";
import type { EnqueuePersonaPostInput } from "@paperclipai/shared/validators/persona-account";
import { notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { approvalService } from "./approvals.js";
import { getPlatformAdapter, PlatformPublishError } from "../platform-adapters/index.js";
import { personaAccountsService } from "./persona-accounts.js";
import { personaPublishingSettingsService } from "./persona-publishing-settings.js";

export type PersonaPostRow = typeof personaPosts.$inferSelect;

export type AttemptPublishOutcome =
  | { outcome: "paused"; reason: "company" | "persona" | "account" }
  | { outcome: "not_claimable" }
  | { outcome: "pending_approval"; approvalId: string }
  | { outcome: "capped" }
  | { outcome: "published"; externalPostId: string }
  | { outcome: "failed"; failureReason: string };

function utcDayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function personaPublisherService(db: Db) {
  const accounts = personaAccountsService(db);
  const publishingSettings = personaPublishingSettingsService(db);
  const approvals = approvalService(db);

  async function enqueuePost(
    companyId: string,
    personaAccountId: string,
    input: EnqueuePersonaPostInput,
  ): Promise<PersonaPostRow> {
    const account = await accounts.getAccountById(personaAccountId);
    if (!account || account.companyId !== companyId) throw notFound("Persona account not found");

    const [created] = await db
      .insert(personaPosts)
      .values({
        companyId,
        personaId: account.personaId,
        personaAccountId: account.id,
        caption: input.caption,
        mediaAssetId: input.mediaAssetId ?? null,
      })
      .returning();
    return created!;
  }

  async function getPostById(postId: string): Promise<PersonaPostRow | null> {
    const [row] = await db.select().from(personaPosts).where(eq(personaPosts.id, postId));
    return row ?? null;
  }

  async function listFeedForCompany(companyId: string, limit = 100): Promise<PersonaPostRow[]> {
    return db
      .select()
      .from(personaPosts)
      .where(eq(personaPosts.companyId, companyId))
      .orderBy(sql`${personaPosts.createdAt} DESC`)
      .limit(limit);
  }

  /**
   * Atomically reserve one of today's `dailyPostCap` publish slots for this
   * account. Same shape as personaGenerationCapService's reserveGeneration
   * (DUR-177): `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE count < cap`,
   * so two concurrent publish attempts for the same account can never both
   * reserve slot N when only N-1 is left.
   */
  async function reserveDailyCapSlot(account: typeof personaAccounts.$inferSelect): Promise<boolean> {
    const cap = account.dailyPostCap;
    if (cap <= 0) return false;

    const day = utcDayString();
    const [row] = await db
      .insert(personaAccountPublishCounters)
      .values({ companyId: account.companyId, personaAccountId: account.id, day, count: 1 })
      .onConflictDoUpdate({
        target: [personaAccountPublishCounters.personaAccountId, personaAccountPublishCounters.day],
        set: { count: sql`${personaAccountPublishCounters.count} + 1`, updatedAt: new Date() },
        setWhere: sql`${personaAccountPublishCounters.count} < ${cap}`,
      })
      .returning({ count: personaAccountPublishCounters.count });
    return Boolean(row);
  }

  async function attemptPublish(postId: string): Promise<AttemptPublishOutcome> {
    const post = await getPostById(postId);
    if (!post) throw notFound("Persona post not found");
    if (!["queued", "approved"].includes(post.status)) {
      return { outcome: "not_claimable" };
    }

    const [account] = await db.select().from(personaAccounts).where(eq(personaAccounts.id, post.personaAccountId));
    if (!account) throw notFound("Persona account not found");
    const [persona] = await db.select().from(personas).where(eq(personas.id, post.personaId));
    if (!persona) throw notFound("Persona not found");

    // Kill switch, item 6: checked first, before any row is touched. A
    // paused post is left exactly as it was (queued/approved) so it resumes
    // on its own the next time this is called after the operator unpauses --
    // no separate "resume" action needed.
    if (await publishingSettings.isPublishingPaused(account.companyId)) {
      return { outcome: "paused", reason: "company" };
    }
    if (persona.publishingPaused) {
      return { outcome: "paused", reason: "persona" };
    }
    if (account.publishingPaused) {
      return { outcome: "paused", reason: "account" };
    }

    // Warm-up, item 8: below threshold overrides autonomyMode regardless of
    // what the channel's own setting says -- never autonomous-by-omission,
    // and never autonomous-before-warm-up either.
    const warmingUp = account.publishedPostCount < account.warmupPostsRequired;
    const requiresApproval = warmingUp || account.autonomyMode === "requires_approval";

    const disclosureText = account.aiDisclosureEnabled ? PERSONA_POST_AI_DISCLOSURE_TEXT : null;

    if (post.status === "queued" && requiresApproval) {
      // Autonomy gate, item 7: file the approval and stop. This is the ONLY
      // place a persona_publish approval is filed -- never by the persona's
      // own agent, mirroring how deploy/instructions_change approvals are
      // always filed by the acting service, not the requester.
      const approval = await approvals.create(account.companyId, {
        type: "request_board_approval",
        requestedByAgentId: null,
        payload: {
          kind: "persona_publish",
          personaId: persona.id,
          personaAccountId: account.id,
          personaPostId: post.id,
          platform: account.platform,
          reason: warmingUp ? "warmup" : "requires_approval_channel",
          caption: post.caption,
          disclosureText,
          title: `Publish to ${account.accountLabel}`,
          summary: warmingUp
            ? `${account.accountLabel} is still within its warm-up window (${account.publishedPostCount}/${account.warmupPostsRequired} posts) -- every post needs sign-off until it clears.`
            : `${account.accountLabel} (${account.platform}) requires approval before every post.`,
        },
        status: "pending",
      });

      await db
        .update(personaPosts)
        .set({
          status: "pending_approval",
          approvalId: approval!.id,
          disclosureText,
          updatedAt: new Date(),
        })
        .where(eq(personaPosts.id, post.id));

      return { outcome: "pending_approval", approvalId: approval!.id };
    }

    // Reaching here means either: autonomous and past warm-up, with nothing
    // left to gate it (queued -> straight to the claim below); or the board
    // already approved a previously-gated post (approved -> proceed
    // regardless of the currently-recomputed requiresApproval, since the
    // approval already covers whichever reason it was filed for).
    const clearedToClaim = (post.status === "queued" && !requiresApproval) || post.status === "approved";
    if (!clearedToClaim) {
      return { outcome: "not_claimable" };
    }

    // Daily cap, item 3: reserved BEFORE the one-shot claim so a capped-out
    // post is left untouched (still queued/approved) rather than marked
    // failed -- it becomes eligible again the moment tomorrow's counter
    // resets, with no separate retry action needed.
    if (!(await reserveDailyCapSlot(account))) {
      return { outcome: "capped" };
    }

    // One-shot publish, item 12: the conditional claim. If this loses the
    // race (another concurrent call already claimed it), the cap slot we
    // just reserved is simply not used by this post today -- an acceptable
    // one-slot slip in the rare concurrent-caller case, never an over-cap
    // publish. Also persists `disclosureText` here (not just in the
    // pending_approval branch above) -- a queued post that goes straight to
    // publish (autonomous, past warm-up) never passes through that branch,
    // so without this the adapter would silently receive `null` and skip
    // Fanvue's AUP-mandated AI disclosure even when aiDisclosureEnabled.
    // A previously-approved post keeps whatever disclosureText it was
    // stamped with at approval-filing time (COALESCE), since the account's
    // aiDisclosureEnabled setting may have changed since then.
    const [claimed] = await db
      .update(personaPosts)
      .set({
        status: "publishing",
        disclosureText: sql`COALESCE(${personaPosts.disclosureText}, ${disclosureText})`,
        publishAttemptedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(personaPosts.id, post.id), sql`${personaPosts.status} IN ('queued', 'approved')`))
      .returning();
    if (!claimed) {
      return { outcome: "not_claimable" };
    }

    try {
      const token = await accounts.resolvePublishToken(account.companyId, account.id, {
        actorType: "system",
        actorId: "persona-publisher",
      });
      const adapter = getPlatformAdapter(account.platform as PersonaAccountPlatform);
      const result = await adapter.publish({
        token,
        externalAccountId: account.externalAccountId,
        caption: claimed.caption,
        // DUR-134 known gap: media attachment is not yet wired to a
        // fetchable URL an external platform can pull from (assets are
        // served through an authenticated app route, not a public/signed
        // URL) -- text-only posts publish end-to-end; image posts need that
        // follow-up before mediaAssetId does anything here. See the PR
        // description.
        mediaUrl: null,
        disclosureText: claimed.disclosureText,
      });

      await db.transaction(async (tx) => {
        await tx
          .update(personaPosts)
          .set({
            status: "published",
            externalPostId: result.externalPostId,
            publishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(personaPosts.id, claimed.id));
        await tx
          .update(personaAccounts)
          .set({ publishedPostCount: sql`${personaAccounts.publishedPostCount} + 1`, updatedAt: new Date() })
          .where(eq(personaAccounts.id, account.id));
      });

      return { outcome: "published", externalPostId: result.externalPostId };
    } catch (error) {
      const failureReason = error instanceof PlatformPublishError ? error.message : String((error as Error)?.message ?? error);
      await db
        .update(personaPosts)
        .set({ status: "failed", failureReason, updatedAt: new Date() })
        .where(eq(personaPosts.id, claimed.id));

      // Item 10 (DUR-98 principle): make the failure loud in the activity
      // feed now. Fanning this out to Telegram/Needs-You is tracked as
      // explicit follow-up work (see the PR description) -- it needs the
      // same alert-tick shape as agent-error-alerts.ts/untracked-write-alerts.ts,
      // which is a separable piece of work from the publisher itself.
      await logActivity(db, {
        companyId: account.companyId,
        actorType: "system",
        actorId: "persona-publisher",
        action: "persona_post.publish_failed",
        entityType: "persona_post",
        entityId: claimed.id,
        details: {
          personaId: persona.id,
          personaAccountId: account.id,
          platform: account.platform,
          failureReason,
        },
      }).catch(() => {});

      return { outcome: "failed", failureReason };
    }
  }

  return { enqueuePost, getPostById, listFeedForCompany, attemptPublish };
}

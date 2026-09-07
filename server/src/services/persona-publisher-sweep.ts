// DUR-134 item 4 (review follow-up): the thing that actually drives
// autonomous publishing. Until this existed, a persona's queued post -- and
// a post Filip had just approved -- sat in persona_posts forever unless a
// board user called POST /persona-posts/:id/attempt-publish by hand, which
// made "autonomous capped publishing" a manual feature in practice.
//
// Runs from the heartbeat scheduler tick (server/src/index.ts), inside the
// tick's bypass scope. Each pass takes at most ONE eligible post per
// account, oldest first, and hands it to attemptPublish, which owns every
// safety gate (kill switches, warm-up, autonomy, daily cap, one-shot
// claim). One-per-account-per-tick means two things for free: a persona
// with ten queued posts drips them out at most one per scheduler interval
// instead of firing all ten at once, and a capped-out account costs one
// cheap reservation query per tick rather than one per queued post.
//
// The operator-facing schedule itself (how often the persona is woken to
// write) stays with routines/routine_triggers -- this sweep only moves
// already-written posts through the gates; it never decides content.
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { personaAccounts, personaPosts, personas } from "@paperclipai/db";
import { personaPublisherService, type AttemptPublishOutcome } from "./persona-publisher.js";

export const PERSONA_PUBLISHER_SWEEP_MAX_POSTS_PER_TICK = 25;

export interface PersonaPublisherSweepResult {
  considered: number;
  published: number;
  pendingApproval: number;
  capped: number;
  paused: number;
  failed: number;
  skipped: number;
  errors: number;
}

export function personaPublisherSweepService(db: Db, options: { maxPostsPerTick?: number } = {}) {
  const publisher = personaPublisherService(db);
  const maxPostsPerTick = options.maxPostsPerTick ?? PERSONA_PUBLISHER_SWEEP_MAX_POSTS_PER_TICK;

  /**
   * The oldest queued/approved post per account whose account and persona
   * are not paused. The company-wide pause is left to attemptPublish (it is
   * a separate lazily-created table); a paused company simply yields a
   * handful of cheap "paused" outcomes per tick.
   */
  async function listEligiblePosts(): Promise<Array<{ id: string; personaAccountId: string }>> {
    const rows = await db
      .select({
        id: personaPosts.id,
        personaAccountId: personaPosts.personaAccountId,
        createdAt: personaPosts.createdAt,
      })
      .from(personaPosts)
      .innerJoin(personaAccounts, eq(personaAccounts.id, personaPosts.personaAccountId))
      .innerJoin(personas, eq(personas.id, personaPosts.personaId))
      .where(
        and(
          sql`${personaPosts.status} IN ('queued', 'approved')`,
          eq(personaAccounts.publishingPaused, false),
          eq(personas.publishingPaused, false),
        ),
      )
      .orderBy(asc(personaPosts.createdAt), asc(personaPosts.id));

    const seenAccounts = new Set<string>();
    const picked: Array<{ id: string; personaAccountId: string }> = [];
    for (const row of rows) {
      if (seenAccounts.has(row.personaAccountId)) continue;
      seenAccounts.add(row.personaAccountId);
      picked.push({ id: row.id, personaAccountId: row.personaAccountId });
      if (picked.length >= maxPostsPerTick) break;
    }
    return picked;
  }

  async function tick(): Promise<PersonaPublisherSweepResult> {
    const result: PersonaPublisherSweepResult = {
      considered: 0,
      published: 0,
      pendingApproval: 0,
      capped: 0,
      paused: 0,
      failed: 0,
      skipped: 0,
      errors: 0,
    };

    const eligible = await listEligiblePosts();
    for (const post of eligible) {
      result.considered += 1;
      let outcome: AttemptPublishOutcome;
      try {
        outcome = await publisher.attemptPublish(post.id);
      } catch {
        // One broken post (deleted account, missing persona) must not stop
        // the rest of the pass; attemptPublish already records what it can.
        result.errors += 1;
        continue;
      }
      switch (outcome.outcome) {
        case "published":
          result.published += 1;
          break;
        case "pending_approval":
          result.pendingApproval += 1;
          break;
        case "capped":
          result.capped += 1;
          break;
        case "paused":
          result.paused += 1;
          break;
        case "failed":
          result.failed += 1;
          break;
        default:
          result.skipped += 1;
      }
    }
    return result;
  }

  return { tick, listEligiblePosts };
}

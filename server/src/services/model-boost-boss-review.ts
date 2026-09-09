/**
 * Pure helpers for the boss-first routing stamp on a model/effort boost ask
 * (agent -> boss -> operator). Kept dependency-free on purpose: the approvals
 * route imports this directly, so it must not drag the full service graph
 * (issues, heartbeat, ...) into route modules that tests otherwise mock away.
 */
import {
  MODEL_BOOST_BOSS_REVIEW_TIMEOUT_MINUTES,
  type ModelBoostBossReviewState,
} from "@paperclipai/shared";

export interface BossCandidate {
  id: string;
  name: string;
}

/** The stamp written onto a freshly filed boost ask when the requester has a boss who can answer. */
export function buildBossReviewStamp(boss: BossCandidate, now: Date = new Date()): ModelBoostBossReviewState {
  return {
    bossAgentId: boss.id,
    bossName: boss.name,
    status: "awaiting_boss",
    requestedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + MODEL_BOOST_BOSS_REVIEW_TIMEOUT_MINUTES * 60_000).toISOString(),
  };
}

export function readBossReview(payload: Record<string, unknown> | null | undefined): ModelBoostBossReviewState | null {
  const raw = payload?.bossReview;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const review = raw as Record<string, unknown>;
  if (typeof review.bossAgentId !== "string" || typeof review.status !== "string") return null;
  return review as unknown as ModelBoostBossReviewState;
}

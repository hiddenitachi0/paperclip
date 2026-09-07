/**
 * Plain-language wording for a model/effort boost ask (agent -> boss ->
 * operator). Shared by the server (which stamps the approval title/summary at
 * filing time), the dashboard card, and the Telegram bridge text, so every
 * surface tells the operator the same thing in the same words:
 *
 *   "Backend Engineer asks to use Opus at high effort for this task,
 *    up to $20, for the next 4 hours"
 */

export interface ModelBoostDescriptionInput {
  agentName: string;
  requestedModel?: string | null;
  requestedEffort?: string | null;
  maxSpendCents: number;
  durationMinutes: number;
}

export interface ModelBoostBossReview {
  bossAgentId: string;
  bossName: string;
  status: "awaiting_boss" | "forwarded" | "declined" | "timed_out";
  requestedAt: string;
  deadlineAt: string;
  decidedAt?: string;
  note?: string;
}

const MODEL_FAMILY_RE = /\b(opus|sonnet|haiku)\b/i;

/** "opus" / "claude-opus-4-1" -> "Opus"; anything unknown is shown as typed. */
export function prettyBoostModel(model: string | null | undefined): string | null {
  const raw = (model ?? "").trim();
  if (!raw) return null;
  const match = raw.match(MODEL_FAMILY_RE);
  if (!match) return raw;
  const family = match[1]!.toLowerCase();
  return family.charAt(0).toUpperCase() + family.slice(1);
}

const EFFORT_WORDS: Record<string, string> = {
  low: "low effort",
  med: "medium effort",
  medium: "medium effort",
  high: "high effort",
  xhigh: "very high effort",
  max: "maximum effort",
  minimal: "minimal effort",
};

/** "high" -> "high effort", "xhigh" -> "very high effort", "max" -> "maximum effort". */
export function prettyBoostEffort(effort: string | null | undefined): string | null {
  const raw = (effort ?? "").trim();
  if (!raw) return null;
  return EFFORT_WORDS[raw.toLowerCase()] ?? `${raw} effort`;
}

/** 240 -> "4 hours", 90 -> "1 hour 30 minutes", 45 -> "45 minutes". */
export function formatBoostDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  const hourPart = hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "";
  const minutePart = mins > 0 ? `${mins} minute${mins === 1 ? "" : "s"}` : "";
  if (hourPart && minutePart) return `${hourPart} ${minutePart}`;
  return hourPart || minutePart || "0 minutes";
}

/** 2000 -> "$20", 1250 -> "$12.50". */
export function formatBoostMoney(cents: number): string {
  const safe = Math.max(0, Math.round(cents));
  if (safe % 100 === 0) return `$${safe / 100}`;
  return `$${(safe / 100).toFixed(2)}`;
}

/**
 * The headline sentence for the approval card and the Telegram message.
 * No trailing period: the server prepends the project label
 * ("<Project> — <sentence>") and the UI uses it as a title.
 */
export function describeModelBoostRequest(input: ModelBoostDescriptionInput): string {
  const who = input.agentName.trim() || "An agent";
  const model = prettyBoostModel(input.requestedModel);
  const effort = prettyBoostEffort(input.requestedEffort);
  let what: string;
  if (model && effort) what = `use ${model} at ${effort}`;
  else if (model) what = `use ${model}`;
  else if (effort) what = `work at ${effort}`;
  else what = "use a stronger setting";
  return `${who} asks to ${what} for this task, up to ${formatBoostMoney(input.maxSpendCents)}, for the next ${formatBoostDuration(input.durationMinutes)}`;
}

/** What approving or denying does, in the operator's words. */
export function describeModelBoostConsequence(input: ModelBoostDescriptionInput): string {
  const who = input.agentName.trim() || "The agent";
  return (
    `If you approve, ${who} switches for this task only and goes back to its normal setting after ` +
    `${formatBoostDuration(input.durationMinutes)} or once the task has cost ${formatBoostMoney(input.maxSpendCents)}, ` +
    `whichever comes first. If you deny, it keeps working on its normal setting.`
  );
}

/**
 * One line telling the operator where the ask is in the chain: waiting for
 * the boss, forwarded by the boss (with the boss's take), or the boss did not
 * answer in time. `null` when there is no boss step (the ask came straight
 * to the operator).
 */
export function describeModelBoostBossReview(review: ModelBoostBossReview | null | undefined): string | null {
  if (!review) return null;
  const boss = review.bossName.trim() || "Their boss";
  switch (review.status) {
    case "awaiting_boss":
      return `Waiting for ${boss} to weigh in first. If ${boss} has not answered by ${formatClock(review.deadlineAt)}, it comes to you.`;
    case "forwarded":
      return review.note?.trim()
        ? `${boss} passed this on to you: ${review.note.trim()}`
        : `${boss} passed this on to you without a recommendation.`;
    case "declined":
      return review.note?.trim() ? `${boss} said no: ${review.note.trim()}` : `${boss} said no.`;
    case "timed_out":
      return `${boss} did not answer in time, so this came to you.`;
    default:
      return null;
  }
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "the deadline";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

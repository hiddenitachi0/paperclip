// The guided Storylines flow: 1 Script -> 2 Pictures -> 3 Budget & render -> 4 Film.
//
// Pure helpers only (no React, no fetch) so the step bar's status lines, the
// "what is missing before you can render" checklist and the mapping of the
// server's start-render refusals to one-click fixes can be unit tested.
//
// Standalone on purpose: this UI bundle cannot import @paperclipai/shared.
// STILL_PICTURE_COST_CENTS copies STILL_IMAGE_PROVIDER_COST_CENTS_PER_IMAGE.fal
// (packages/shared/src/video-storyline-stills.ts) -- stills are always priced
// as one Fal image call on the server. Keep it in sync by hand.

export const STILL_PICTURE_COST_CENTS = 2;

export type FlowStepKey = "script" | "pictures" | "render" | "film";

export const FLOW_STEPS: Array<{ key: FlowStepKey; number: number; title: string }> = [
  { key: "script", number: 1, title: "Script" },
  { key: "pictures", number: 2, title: "Pictures" },
  { key: "render", number: 3, title: "Budget & render" },
  { key: "film", number: 4, title: "Film" },
];

/** The storyline fields the flow needs (a subset of the page's VideoStorylineSummary). */
export interface FlowStoryline {
  id: string;
  status: string;
  budgetCapCents: number | null;
  spentCents: number;
  estimatedTotalCents: number | null;
  finalObjectKey: string | null;
}

export interface FlowStoryboardShot {
  id: string;
  orderIndex: number;
  storyboardStatus: "pending" | "approved" | "dropped";
  stillObjectKey: string | null;
}

export interface FlowStoryboard {
  shots: FlowStoryboardShot[];
  allApproved: boolean;
  videoEstimatedTotalCents: number | null;
  approvalThresholdCents: number | null;
  /** What one storyboard picture costs on the chosen picture service (older servers leave it out). */
  picture?: { costPerPictureCents: number } | null;
}

/** Rough cost of one storyboard picture on the chosen service. */
export function pictureCostCents(storyboard: FlowStoryboard | null): number {
  return storyboard?.picture?.costPerPictureCents ?? STILL_PICTURE_COST_CENTS;
}

export interface FlowProgress {
  totalShots: number;
  doneShots: number;
  failedShots: number;
  renderingShots: number;
}

export interface FlowInput {
  storyline: FlowStoryline;
  /** Number of shots in the script (from the shots list). */
  shotCount: number;
  /** Shots whose AI director suggestion is waiting for Accept / Reject / Edit. */
  pendingSuggestions: number;
  storyboard: FlowStoryboard | null;
  progress: FlowProgress | null;
  /** The owner's go-ahead was requested and has not come back yet. */
  approvalPending?: boolean;
}

/** Statuses where the shots can still be changed and a render can be started. */
export const EDITABLE_STATUSES = new Set(["draft", "estimated", "paused", "failed", "cancelled"]);
/** Statuses where something is happening in the background (the page polls). */
export const BUSY_STATUSES = new Set(["rendering", "stitching", "ready_to_stitch"]);
/** Statuses that belong to step 4: a render was started at some point. */
const FILM_STATUSES = new Set(["rendering", "stitching", "ready_to_stitch", "done", "needs_attention", "paused"]);

export interface PictureCounts {
  /** Shots that will be in the film (not left out). */
  total: number;
  approved: number;
  approvedWithPicture: number;
  approvedWithoutPicture: number;
  /** Has a picture that still needs the person's OK. */
  waiting: number;
  /** Has no picture and no OK yet. */
  missing: number;
  dropped: number;
  waitingIds: string[];
  missingIds: string[];
}

export function pictureCounts(storyboard: FlowStoryboard | null): PictureCounts {
  const counts: PictureCounts = { total: 0, approved: 0, approvedWithPicture: 0, approvedWithoutPicture: 0, waiting: 0, missing: 0, dropped: 0, waitingIds: [], missingIds: [] };
  for (const shot of (storyboard?.shots ?? []).slice().sort((a, b) => a.orderIndex - b.orderIndex)) {
    if (shot.storyboardStatus === "dropped") {
      counts.dropped += 1;
      continue;
    }
    counts.total += 1;
    if (shot.storyboardStatus === "approved") {
      counts.approved += 1;
      if (shot.stillObjectKey) counts.approvedWithPicture += 1;
      else counts.approvedWithoutPicture += 1;
    } else if (shot.stillObjectKey) {
      counts.waiting += 1;
      counts.waitingIds.push(shot.id);
    } else {
      counts.missing += 1;
      counts.missingIds.push(shot.id);
    }
  }
  return counts;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Estimate + 20%, rounded up to whole dollars (in cents). Null when there is no estimate yet. */
export function suggestedBudgetCents(estimateCents: number | null): number | null {
  if (estimateCents === null || estimateCents <= 0) return null;
  return Math.ceil((estimateCents * 1.2) / 100) * 100;
}

function storylineEstimate(input: FlowInput): number | null {
  return input.storyboard?.videoEstimatedTotalCents ?? input.storyline.estimatedTotalCents;
}

// ─── Step status ─────────────────────────────────────────────────────────

export type StepState = "done" | "ready" | "attention" | "todo" | "working";

export interface StepStatus {
  key: FlowStepKey;
  number: number;
  title: string;
  /** One short plain line, e.g. "6 of 9 pictures approved". */
  status: string;
  state: StepState;
}

function filmStatus(input: FlowInput): { status: string; state: StepState } {
  const { storyline, progress } = input;
  const total = progress?.totalShots ?? 0;
  const done = progress?.doneShots ?? 0;
  switch (storyline.status) {
    case "rendering":
      return { status: total > 0 ? `Rendering ${Math.min(done + 1, total)} of ${total}` : "Rendering", state: "working" };
    case "ready_to_stitch":
      return { status: "All clips done, combining soon", state: "working" };
    case "stitching":
      return { status: "Combining clips", state: "working" };
    case "done":
      return { status: "Film ready", state: "done" };
    case "needs_attention":
      return { status: "Film ready, check found problems", state: "attention" };
    case "paused":
      return { status: total > 0 ? `Paused, ${done} of ${total} clips done` : "Paused", state: "attention" };
    case "failed":
      return { status: "Render failed", state: "attention" };
    case "cancelled":
      return { status: done > 0 ? `Cancelled, ${done} of ${total} clips kept` : "Cancelled", state: "attention" };
    default:
      return { status: "Not started", state: "todo" };
  }
}

export function computeSteps(input: FlowInput): StepStatus[] {
  const counts = pictureCounts(input.storyboard);
  const started = FILM_STATUSES.has(input.storyline.status);

  const script: Pick<StepStatus, "status" | "state"> =
    input.shotCount === 0
      ? { status: "No shots yet", state: "todo" }
      : input.pendingSuggestions > 0
        ? { status: `${plural(input.shotCount, "shot")}, ${plural(input.pendingSuggestions, "AI suggestion")} waiting`, state: "attention" }
        : { status: plural(input.shotCount, "shot"), state: "done" };

  let pictures: Pick<StepStatus, "status" | "state">;
  if (input.shotCount === 0) pictures = { status: "Write the script first", state: "todo" };
  else if (!input.storyboard) pictures = { status: "Loading...", state: "todo" };
  else if (counts.total === 0) pictures = { status: "Every shot is left out", state: "attention" };
  else {
    const left = counts.dropped > 0 ? ` (${counts.dropped} left out)` : "";
    pictures = {
      status: `${counts.approved} of ${counts.total} pictures approved${left}`,
      state: counts.approved === counts.total ? "done" : "todo",
    };
  }

  let render: Pick<StepStatus, "status" | "state">;
  if (started) render = { status: "Render started", state: "done" };
  else if (input.approvalPending) render = { status: "Waiting for the owner's go-ahead", state: "working" };
  else {
    const readiness = renderReadiness(input);
    const blocking = readiness.items.filter((i) => i.blocking).length;
    render = readiness.ready ? { status: "Ready to render", state: "ready" } : { status: `${plural(blocking, "thing")} to sort out first`, state: "todo" };
  }

  const film = filmStatus(input);
  const byKey: Record<FlowStepKey, Pick<StepStatus, "status" | "state">> = { script, pictures, render, film };
  return FLOW_STEPS.map((s) => ({ ...s, ...byKey[s.key] }));
}

/** The step to open when a storyline is picked: where the next thing to do is. */
export function suggestedStep(input: FlowInput): FlowStepKey {
  if (FILM_STATUSES.has(input.storyline.status)) return "film";
  if (input.shotCount === 0 || input.pendingSuggestions > 0) return "script";
  const counts = pictureCounts(input.storyboard);
  if (!input.storyboard || counts.total === 0 || counts.approved < counts.total) return "pictures";
  return "render";
}

// ─── Readiness checklist (step 3) ────────────────────────────────────────

export type ReadinessFix =
  | { kind: "go"; step: FlowStepKey; label: string }
  | { kind: "make-pictures"; shotIds: string[]; label: string }
  | { kind: "skip-pictures"; shotIds: string[]; label: string }
  | { kind: "approve-pictures"; shotIds: string[]; label: string }
  | { kind: "set-budget"; cents: number; label: string }
  | { kind: "estimate"; label: string }
  | { kind: "refresh"; label: string };

export interface ReadinessItem {
  id: string;
  /** True = the render cannot start until this is fixed. False = worth knowing, not a blocker. */
  blocking: boolean;
  text: string;
  fixes: ReadinessFix[];
}

export const SKIP_PICTURES_EXPLANATION =
  "Skipping approves a shot on its written description alone: no picture is made or paid for, but you don't see how it will look first. " +
  "When the video is made, that shot starts from the last frame of the previous clip (or, for the first shot, from your character picture), so it may drift from what you pictured.";

/** The "missing pictures" item (shared by the checklist and the server-refusal mapping). */
function pictureItems(counts: PictureCounts, costEach: number): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  if (counts.missing > 0) {
    items.push({
      id: "pictures-missing",
      blocking: true,
      text: `${plural(counts.missing, "shot has", "shots have")} no approved picture yet.`,
      fixes: [
        { kind: "make-pictures", shotIds: counts.missingIds, label: `Make ${counts.missing === 1 ? "it" : "them"} (about ${dollars(counts.missing * costEach)})` },
        { kind: "skip-pictures", shotIds: counts.missingIds, label: `Skip pictures for ${counts.missing === 1 ? "this shot" : "these"}` },
      ],
    });
  }
  if (counts.waiting > 0) {
    items.push({
      id: "pictures-waiting",
      blocking: true,
      text: `${plural(counts.waiting, "picture is", "pictures are")} made but not approved yet.`,
      fixes: [
        { kind: "approve-pictures", shotIds: counts.waitingIds, label: counts.waiting === 1 ? "Approve it" : `Approve all ${counts.waiting}` },
        { kind: "go", step: "pictures", label: "Look at them first" },
      ],
    });
  }
  return items;
}

export function renderReadiness(input: FlowInput): { ready: boolean; items: ReadinessItem[] } {
  const items: ReadinessItem[] = [];
  const { storyline } = input;

  if (!EDITABLE_STATUSES.has(storyline.status)) {
    items.push({ id: "not-editable", blocking: true, text: "A render has already started for this storyline. Follow it in step 4.", fixes: [{ kind: "go", step: "film", label: "Go to Film" }] });
    return { ready: false, items };
  }
  if (input.shotCount === 0) {
    items.push({ id: "no-shots", blocking: true, text: "There are no shots yet.", fixes: [{ kind: "go", step: "script", label: "Write or import the script" }] });
    return { ready: false, items };
  }

  const counts = pictureCounts(input.storyboard);
  if (!input.storyboard) {
    items.push({ id: "pictures-loading", blocking: true, text: "Still checking the pictures...", fixes: [{ kind: "refresh", label: "Check again" }] });
  } else if (counts.total === 0) {
    items.push({ id: "all-dropped", blocking: true, text: "Every shot is left out, so there is nothing to render.", fixes: [{ kind: "go", step: "pictures", label: "Bring a shot back" }] });
  } else {
    items.push(...pictureItems(counts, pictureCostCents(input.storyboard)));
  }

  const estimate = storylineEstimate(input);
  if (estimate === null) {
    items.push({ id: "no-estimate", blocking: false, text: "The cost has not been worked out yet.", fixes: [{ kind: "estimate", label: "Work out the cost" }] });
  }

  const suggested = suggestedBudgetCents(estimate);
  if (storyline.budgetCapCents === null) {
    items.push({
      id: "no-budget",
      blocking: true,
      text: "No budget set. Rendering never starts without a spending limit, and it stops if the limit would be passed.",
      fixes: suggested !== null ? [{ kind: "set-budget", cents: suggested, label: `Set budget to ${dollars(suggested)} (estimate + 20%)` }] : [],
    });
  } else if (storyline.spentCents === 0 && estimate !== null && estimate > storyline.budgetCapCents) {
    // Only checked before anything is spent: once clips are done, part of the estimate is already paid for, and the server does the exact sum.
    items.push({
      id: "budget-too-low",
      blocking: true,
      text: `The budget of ${dollars(storyline.budgetCapCents)} is below the estimated ${dollars(estimate)}.`,
      fixes: suggested !== null ? [{ kind: "set-budget", cents: suggested, label: `Raise budget to ${dollars(suggested)} (estimate + 20%)` }] : [],
    });
  }

  if (input.pendingSuggestions > 0) {
    items.push({
      id: "suggestions",
      blocking: false,
      text: `${plural(input.pendingSuggestions, "AI suggestion is", "AI suggestions are")} still waiting. They are left out of the film unless you accept them.`,
      fixes: [{ kind: "go", step: "script", label: "Review suggestions" }],
    });
  }

  return { ready: items.every((i) => !i.blocking), items };
}

/**
 * Turns the server's refusal to start a render (video-storyline-render.ts's
 * startRender messages) into a checklist item with the same one-click fixes,
 * so the person never has to work out from a sentence what to press.
 * Returns null for the owner's-go-ahead case: that is a wait, not a problem.
 */
export function refusalToItem(message: string, input: FlowInput): ReadinessItem | null {
  if (/Waiting on a board decision/i.test(message)) return null;

  if (/storyboard still has not been approved/i.test(message)) {
    const items = pictureItems(pictureCounts(input.storyboard), pictureCostCents(input.storyboard));
    return {
      id: "refusal-pictures",
      blocking: true,
      text: (() => {
        const shot = /Shot (\d+)'s/i.exec(message);
        return shot ? `Shot ${shot[1]} has no approved picture yet, so the render was not started.` : "Some shots have no approved picture yet, so the render was not started.";
      })(),
      fixes: items.length > 0 ? items.flatMap((i) => i.fixes) : [{ kind: "go", step: "pictures", label: "Go to Pictures" }],
    };
  }

  const raise = /at least \$([\d,]+(?:\.\d+)?)/i.exec(message);
  if (/over the budget cap/i.test(message) && raise) {
    const cents = Math.ceil(Number(raise[1]!.replace(/,/g, "")) * 100);
    return { id: "refusal-budget-low", blocking: true, text: message, fixes: [{ kind: "set-budget", cents, label: `Raise budget to ${dollars(cents)}` }] };
  }

  if (/Set a budget cap/i.test(message)) {
    const suggested = suggestedBudgetCents(storylineEstimate(input));
    return {
      id: "refusal-no-budget",
      blocking: true,
      text: "No budget set. Rendering never starts without a spending limit.",
      fixes: suggested !== null ? [{ kind: "set-budget", cents: suggested, label: `Set budget to ${dollars(suggested)} (estimate + 20%)` }] : [],
    };
  }

  if (/Add at least one shot/i.test(message)) {
    return { id: "refusal-no-shots", blocking: true, text: "There are no shots yet.", fixes: [{ kind: "go", step: "script", label: "Write or import the script" }] };
  }

  if (/API key is configured|plugin is not installed/i.test(message)) {
    return { id: "refusal-no-key", blocking: true, text: `${message} Ask an admin to add it under Media Studio's Settings tab.`, fixes: [] };
  }

  if (/already (rendering|stitching|done|ready to stitch|needs attention)|shots changed while/i.test(message)) {
    return { id: "refusal-stale", blocking: true, text: message, fixes: [{ kind: "refresh", label: "Refresh" }] };
  }

  return { id: "refusal-other", blocking: true, text: message, fixes: [] };
}

import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, KeyRound } from "lucide-react";
import {
  ESCALATION_GRANT_DEFAULT_DURATION_MINUTES,
  describeModelBoostBossReview,
  describeModelBoostConsequence,
  formatBoostDuration,
  formatBoostMoney,
  prettyBoostEffort,
  prettyBoostModel,
  type ModelBoostBossReview,
} from "@paperclipai/shared";
import { formatCents } from "../lib/utils";
import { workingStyleTitle } from "./WorkingStyleSection";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
  credential_request: "Credential Request",
};

/**
 * Read the requested-credential fields an agent puts on a credential_request
 * payload. `isPersonaRequest`/`personaDisplayName` come from the server
 * (see withPersonaMetadata in server/src/routes/approvals.ts, DUR-177) —
 * they are never client-guessed, so a non-persona request never picks up
 * persona phrasing by accident.
 */
export function credentialRequestFields(payload?: Record<string, unknown> | null): {
  label: string;
  envKey: string | null;
  description: string | null;
  isPersonaRequest: boolean;
  personaDisplayName: string | null;
} {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const envKey = str(payload?.envKey) ?? str(payload?.key);
  const label = str(payload?.name) ?? str(payload?.title) ?? envKey ?? "Credential";
  const description = str(payload?.description) ?? str(payload?.summary) ?? str(payload?.reason);
  const personaDisplayName = str(payload?.personaDisplayName);
  return {
    label,
    envKey,
    description,
    isPersonaRequest: Boolean(payload?.isPersonaRequest) && !!personaDisplayName,
    personaDisplayName,
  };
}

/**
 * Plain-language name for a credential request (DUR-177 item 16) — e.g.
 * "Maja's Instagram access token" instead of exposing the raw `envKey`
 * ("Value for META_IG_TOKEN") to a non-technical operator. Falls back to
 * the existing envKey-based phrasing for non-persona requests, unchanged.
 */
export function credentialRequestFriendlyName(payload?: Record<string, unknown> | null): string {
  const { label, envKey, isPersonaRequest, personaDisplayName } = credentialRequestFields(payload);
  if (isPersonaRequest && personaDisplayName) {
    return `${personaDisplayName}'s ${label}`;
  }
  return envKey ? `Value for ${envKey}` : "Credential value";
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/**
 * Small secondary line for the approval detail view — PR number, repo, branch,
 * commit. The title itself never carries these (see DUR-24); this is where an
 * agent/operator who needs the technical trail finds it.
 */
export function approvalTechnicalReference(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(payload?.technicalReference);
}

/**
 * True when this approval was requested by an agent with a `personas` row
 * (see withPersonaMetadata in server/src/routes/approvals.ts, DUR-177) —
 * server-derived, not guessed client-side. Used to keep a non-technical
 * operator reviewing a persona's request (a generated caption/image, a
 * credential ask) away from internal plumbing like the approval UUID or
 * raw JSON payload (item 17) without changing anything for ordinary,
 * non-persona approvals.
 */
export function approvalIsPersonaRequest(payload?: Record<string, unknown> | null): boolean {
  return Boolean(payload?.isPersonaRequest);
}

/**
 * Compact "what this acts on" badge for a list row — a PR number for a
 * merge_pr board approval, a short commit for a deploy. Unlike
 * approvalTechnicalReference (full sentence, detail page only), this is
 * short enough to sit on the row itself (see DUR-156).
 */
export function approvalTargetBadge(payload?: Record<string, unknown> | null): string | null {
  const kind = firstNonEmptyString(payload?.kind);
  const prNumber = payload?.prNumber;
  if (kind === "merge_pr" && prNumber !== undefined && prNumber !== null && prNumber !== "") {
    return `PR #${prNumber}`;
  }
  const commit = firstNonEmptyString(payload?.commit);
  if (kind === "deploy" && commit) {
    return `commit ${commit.slice(0, 7)}`;
  }
  return null;
}

/**
 * Which branch a deploy approval's commit actually lives on, and whether
 * that matches the project's deploy branch (DUR-226 — a deploy card must
 * never look identical for a same-branch deploy and an off-branch one; see
 * the DUR-221 incident where a master commit was filed against a project
 * that deploys from custom with no visible difference on the card).
 * Returns null when this isn't a deploy approval, or the source branch
 * hasn't been resolved yet (older approvals filed before the backend
 * started populating it) — callers should render nothing in that case
 * rather than imply "checked, all clear".
 */
export function approvalDeployBranchInfo(payload?: Record<string, unknown> | null): {
  sourceBranch: string;
  deployBranch: string | null;
  mismatch: boolean;
} | null {
  const kind = firstNonEmptyString(payload?.kind);
  if (kind !== "deploy") return null;
  const sourceBranch = firstNonEmptyString(payload?.sourceBranch);
  if (!sourceBranch) return null;
  const deployBranch = firstNonEmptyString(payload?.deployBranch);
  return {
    sourceBranch,
    deployBranch,
    mismatch: Boolean(deployBranch) && deployBranch !== sourceBranch,
  };
}

/**
 * DUR-3964: one plain sentence naming the commit this deploy card would really
 * ship, from the stamp the server worked out at filing time. A card that pins a
 * commit ships that commit; a card that pins none (the board deploying the top
 * of a branch on purpose) ships whatever is at the top of that branch when it is
 * approved, and the sentence says so rather than showing a blank where the
 * commit should be. Returns null when the card carries no stamp (an older card,
 * or one filed while GitHub could not be reached) — the card then says nothing
 * rather than implying "checked".
 */
export function approvalDeployTargetCommitText(payload?: Record<string, unknown> | null): string | null {
  if (firstNonEmptyString(payload?.kind) !== "deploy") return null;
  const resolvedCommit = firstNonEmptyString(payload?.resolvedCommit);
  if (!resolvedCommit) return null;
  const short = resolvedCommit.slice(0, 12);
  if (firstNonEmptyString(payload?.resolvedCommitSource) !== "branch_tip") {
    return `Will deploy commit ${short}.`;
  }
  const branch = firstNonEmptyString(payload?.deployBranch);
  const branchClause = branch ? `the top of ${branch}` : "the top of the branch";
  return `Will deploy ${branchClause} — that was commit ${short} when this card was filed.`;
}

/**
 * Pointless deploy cards: one plain sentence saying what a deploy card would actually change
 * — the version running now, and how many files differ from it — from the
 * summary the server stamped on the payload at filing time. Returns null when
 * the card carries no summary (an older card, or one filed while GitHub could
 * not be reached): the card then says nothing rather than implying "checked,
 * this ships real work".
 */
export function approvalDeployChangeSummaryText(payload?: Record<string, unknown> | null): string | null {
  if (firstNonEmptyString(payload?.kind) !== "deploy") return null;
  const summary = payload?.changesSinceLive;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const record = summary as Record<string, unknown>;
  const liveCommit = firstNonEmptyString(record.liveCommit);
  if (!liveCommit) return null;
  const count = typeof record.changedFileCount === "number" ? record.changedFileCount : null;
  if (count === null) return null;
  const live = liveCommit.slice(0, 12);
  if (count === 0) return `Nothing differs from the version running now (${live}).`;
  const fileWord = count === 1 ? "1 file" : `${count} files`;
  return record.documentationOnly === true
    ? `Changes ${fileWord} since the version running now (${live}) — written notes only.`
    : `Changes ${fileWord} since the version running now (${live}).`;
}

/**
 * DUR-3923: a board approval whose kind only LOOKS like a deploy ("deploy_pr",
 * "deploy_release", "rollout", ...) is one nothing acts on -- scripts/deploy-runner.sh
 * only handles kind "deploy", and the server refuses to approve these. Mirrors
 * isUnsupportedDeployLikeKind() in server/src/services/deploy-workspace.ts so the card
 * says so BEFORE the operator clicks Approve. Returns the plain-language warning, or
 * null for a real deploy card / anything that isn't deploy-shaped.
 */
export function approvalUnsupportedDeployKindWarning(
  type: string | null | undefined,
  payload?: Record<string, unknown> | null,
): string | null {
  if (type !== "request_board_approval") return null;
  const kind = firstNonEmptyString(payload?.kind);
  if (!kind || kind === "deploy") return null;
  if (!/deploy|release|rollout|ship/i.test(kind)) return null;
  return (
    `Nothing will act on this card: it was filed with kind "${kind}", but only cards with kind "deploy" ` +
    "get deployed. Reject it and ask the agent to file a proper deploy approval."
  );
}

/**
 * DUR-3952 (DUR-137 follow-up): a deploy approval filed with
 * `allowBackwardDeploy` is an intentional rollback -- approving it moves
 * production back to an older commit and discards whatever shipped since.
 * That must never look like an ordinary deploy card, so every surface that
 * renders a deploy approval shows it as a rollback.
 */
export function approvalIsRollbackDeploy(payload?: Record<string, unknown> | null): boolean {
  return firstNonEmptyString(payload?.kind) === "deploy" && payload?.allowBackwardDeploy === true;
}

/**
 * Key used to detect two pending approvals that target the same underlying
 * thing — same repo+PR for a merge, same commit for a deploy — so the Now
 * view can flag them as duplicates of each other (DUR-156). Mirrors the
 * server-side filing-time guard (findOpenMergePrApproval) for merge_pr;
 * deploy is keyed by commit here rather than projectId+workspaceId because
 * that's what the operator actually needs to tell apart on the row.
 */
export function approvalDuplicateKey(payload?: Record<string, unknown> | null): string | null {
  const kind = firstNonEmptyString(payload?.kind);
  if (kind === "merge_pr") {
    const repo = firstNonEmptyString(payload?.repo) ?? "";
    const prNumber = payload?.prNumber;
    if (prNumber === undefined || prNumber === null || prNumber === "") return null;
    return `merge_pr:${repo}:${prNumber}`;
  }
  if (kind === "deploy") {
    const commit = firstNonEmptyString(payload?.commit);
    if (!commit) return null;
    return `deploy:${commit}`;
  }
  return null;
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
  credential_request: KeyRound,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      {/* DUR-3971: the working-style choice made when this person was
          employed, in the same words the operator was offered. */}
      <div className="flex items-start gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Works</span>
        <span className="min-w-0">{workingStyleTitle(payload.laneAEnabled === true)}</span>
      </div>
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  if (firstNonEmptyString(payload.kind) === "feature_launch") {
    return <FeatureLaunchPayloadContent payload={nextPayload} />;
  }
  if (firstNonEmptyString(payload.kind) === "persona_publish") {
    return <PersonaPublishPayloadContent payload={nextPayload} />;
  }
  if (firstNonEmptyString(payload.kind) === "model_boost") {
    return <ModelBoostPayloadContent payload={nextPayload} />;
  }
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

/**
 * Reads the server-stamped boss-review state off a model_boost payload
 * (see stampModelBoostPlainLanguage in server/src/routes/approvals.ts).
 * Absent means the ask came straight to the operator (no boss to ask first).
 */
export function modelBoostBossReview(payload?: Record<string, unknown> | null): ModelBoostBossReview | null {
  const raw = payload?.bossReview;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const review = raw as Record<string, unknown>;
  const bossAgentId = firstNonEmptyString(review.bossAgentId);
  const status = firstNonEmptyString(review.status);
  if (!bossAgentId || !status) return null;
  if (status !== "awaiting_boss" && status !== "forwarded" && status !== "declined" && status !== "timed_out") return null;
  return {
    bossAgentId,
    bossName: firstNonEmptyString(review.bossName) ?? "Their boss",
    status,
    requestedAt: firstNonEmptyString(review.requestedAt) ?? "",
    deadlineAt: firstNonEmptyString(review.deadlineAt) ?? "",
    decidedAt: firstNonEmptyString(review.decidedAt) ?? undefined,
    note: firstNonEmptyString(review.note) ?? undefined,
  };
}

/**
 * A working agent asking for a temporary model/effort boost on its current
 * task (agent -> boss -> operator). The title already reads "<Agent> asks to
 * use Opus at high effort for this task, up to $20, for the next 4 hours";
 * the card adds why, where the ask is in the chain, and what approve/deny do.
 */
function ModelBoostPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const title = firstNonEmptyString(payload.title);
  const reason = firstNonEmptyString(payload.reason);
  const agentName = firstNonEmptyString(payload.agentName) ?? "The agent";
  const model = prettyBoostModel(firstNonEmptyString(payload.requestedModel));
  const effort = prettyBoostEffort(firstNonEmptyString(payload.requestedEffort));
  const maxSpendCents = typeof payload.maxSpendCents === "number" ? payload.maxSpendCents : 0;
  const durationMinutes =
    typeof payload.durationMinutes === "number" ? payload.durationMinutes : ESCALATION_GRANT_DEFAULT_DURATION_MINUTES;
  const review = modelBoostBossReview(payload);
  const reviewLine = describeModelBoostBossReview(review);
  const consequence = describeModelBoostConsequence({
    agentName,
    requestedModel: firstNonEmptyString(payload.requestedModel),
    requestedEffort: firstNonEmptyString(payload.requestedEffort),
    maxSpendCents,
    durationMinutes,
  });
  const waitingOnBoss = review?.status === "awaiting_boss";

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {reason && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Why {agentName} asks</p>
          <p className="whitespace-pre-line leading-6 text-foreground/90">{reason}</p>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">What changes</p>
        <p className="leading-6 text-foreground/90">
          {[
            model ? `Model: ${model}` : null,
            effort ? `Effort: ${effort.replace(/ effort$/, "")}` : null,
            `Money cap: ${formatBoostMoney(maxSpendCents)}`,
            `Time window: ${formatBoostDuration(durationMinutes)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      {reviewLine && (
        <div
          className={
            waitingOnBoss
              ? "rounded-lg border border-border/60 bg-muted/40 px-3.5 py-3"
              : "rounded-lg border border-sky-500/20 bg-sky-500/10 px-3.5 py-3"
          }
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {waitingOnBoss ? "Their boss goes first" : "What their boss said"}
          </p>
          <p className="mt-1 leading-6 text-foreground">{reviewLine}</p>
          {waitingOnBoss && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              You can still decide now if you do not want to wait.
            </p>
          )}
        </div>
      )}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
          If you approve
        </p>
        <p className="mt-1 leading-6 text-foreground">{consequence}</p>
      </div>
    </div>
  );
}

/**
 * DUR-299 point 2's launch gate card: what's new, where to find it, what to
 * test, what happens if it fails. These four fields are required by
 * featureLaunchRequestPayloadSchema (packages/shared/src/validators/approval.ts)
 * -- render them as labeled plain text instead of falling through to the
 * generic board-approval fields (title/summary/risks/...), which don't exist
 * on this payload shape.
 */
function FeatureLaunchPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const title = firstNonEmptyString(payload.title);
  const whatIsNew = firstNonEmptyString(payload.whatIsNew);
  const whereToFindIt = firstNonEmptyString(payload.whereToFindIt);
  const whatToTest = firstNonEmptyString(payload.whatToTest);
  const whatIfItFails = firstNonEmptyString(payload.whatIfItFails);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {whatIsNew && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">What's new</p>
          <p className="leading-6 text-foreground/90">{whatIsNew}</p>
        </div>
      )}
      {whereToFindIt && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Where to find it</p>
          <p className="leading-6 text-foreground/90">{whereToFindIt}</p>
        </div>
      )}
      {whatToTest && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">What to test</p>
          <p className="leading-6 text-foreground/90">{whatToTest}</p>
        </div>
      )}
      {whatIfItFails && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
            If it fails
          </p>
          <p className="mt-1 leading-6 text-foreground">{whatIfItFails}</p>
        </div>
      )}
    </div>
  );
}

/**
 * DUR-134: a persona asking to post. Filed by the publisher (never the
 * persona's own agent) when the account is still warming up or always needs
 * approval. What the operator needs on the card: the exact text going out,
 * whether an AI-disclosure line is added, why they are being asked, and what
 * approve/reject does -- all of which the payload carries in plain words.
 */
function PersonaPublishPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const caption = firstNonEmptyString(payload.caption);
  const disclosureText = firstNonEmptyString(payload.disclosureText);
  const personaDisplayName = firstNonEmptyString(payload.personaDisplayName);
  const reason = firstNonEmptyString(payload.reason);
  const reasonLabel =
    reason === "warmup"
      ? "New account: her first posts need your OK"
      : reason === "requires_approval_channel"
        ? "This account always needs your OK"
        : null;

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {caption && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {personaDisplayName ? `What ${personaDisplayName} wants to post` : "What she wants to post"}
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 leading-6 text-foreground">{caption}</p>
        </div>
      )}
      <div className="space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">AI disclosure</p>
        <p className="leading-6 text-foreground/90">
          {disclosureText
            ? `Added under the post: "${disclosureText}"`
            : "Not added -- disclosure is switched off for this account."}
        </p>
      </div>
      {(reasonLabel || summary) && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Why you are asked</p>
          {reasonLabel && <p className="font-medium leading-6 text-foreground">{reasonLabel}</p>}
          {summary && <p className="leading-6 text-foreground/90">{summary}</p>}
        </div>
      )}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
          If you approve
        </p>
        <p className="mt-1 leading-6 text-foreground">
          It is posted at the next publishing pass, as long as publishing is not paused and today's limit is not
          used up. If you reject, it is never posted.
        </p>
      </div>
    </div>
  );
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  // Operator cards the server files for itself (done_gate_exhausted, goal_condition_exhausted)
  // carry their findings in `plainSummary`; fall back to it so the card never shows a
  // recommended action without the facts behind it. Multi-line summaries keep their lines.
  const summary = firstNonEmptyString(payload.summary, payload.plainSummary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Summary</p>
          <p className="whitespace-pre-line leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">On approval</p>
          <p className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Proposed comment
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  if (type === "credential_request") return <CredentialRequestPayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}

function CredentialRequestPayload({ payload }: { payload: Record<string, unknown> }) {
  const { label, envKey, description, isPersonaRequest, personaDisplayName } = credentialRequestFields(payload);
  return (
    <div className="space-y-3">
      <PayloadField
        label="Credential"
        value={isPersonaRequest && personaDisplayName ? `${personaDisplayName}'s ${label}` : label}
      />
      {/* DUR-177 item 16: the raw envKey is internal plumbing an agent chose for
          itself -- never render it for a persona-related request. */}
      {envKey && !isPersonaRequest ? <PayloadField label="Environment variable" value={envKey} /> : null}
      {description ? <PayloadField label="Why it's needed" value={description} /> : null}
      <p className="text-xs text-muted-foreground">
        Provide the value below — it is stored as an encrypted company secret, and the requesting
        agent is woken to continue once you submit.
      </p>
    </div>
  );
}

import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, KeyRound } from "lucide-react";
import { formatCents } from "../lib/utils";

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
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
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
  const summary = firstNonEmptyString(payload.summary);
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
          <p className="leading-6 text-foreground/90">{summary}</p>
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

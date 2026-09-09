/**
 * Preview environments — "look at the pending code before you approve it".
 *
 * An operator deciding a merge or a deploy card has, until now, had to say yes
 * or no without ever seeing the change running. A preview is a throwaway copy
 * of exactly the code that card would ship, started on the same machine, and
 * reachable through the server at `/_preview/<workspace id>/`.
 *
 * Everything in this file is shared between the server (which starts and stops
 * previews) and the UI (which shows the button and the link), so both describe
 * a preview to the operator with the same words.
 */

/** Where the operator-only preview proxy is mounted on the server. */
export const PREVIEW_PROXY_PATH_PREFIX = "/_preview";

/** How long a preview may sit untouched before it is thrown away, in minutes. */
export const PREVIEW_DEFAULT_IDLE_TIMEOUT_MINUTES = 60;

/** How many previews one Paperclip instance may run at the same time. */
export const PREVIEW_DEFAULT_MAX_CONCURRENT = 2;

/**
 * Lifecycle of one preview, in the order it moves through. `stopped` and
 * `failed` are both dead ends — a preview is never restarted in place, it is
 * thrown away and a new one is started.
 */
export type PreviewEnvironmentStatus = "starting" | "ready" | "failed" | "stopped";

export const PREVIEW_ENVIRONMENT_STATUSES: PreviewEnvironmentStatus[] = [
  "starting",
  "ready",
  "failed",
  "stopped",
];

/** What a preview was started from: a pinned commit, or the tip of a branch. */
export type PreviewEnvironmentRefKind = "commit" | "branch";

export interface PreviewEnvironmentRef {
  kind: PreviewEnvironmentRefKind;
  /** The commit sha or branch name, exactly as it will be checked out. */
  value: string;
  /** Plain-language description, e.g. "the branch build/fix-login". */
  label: string;
}

/** One preview, as the API returns it and the UI renders it. */
export interface PreviewEnvironment {
  approvalId: string;
  companyId: string;
  projectId: string;
  /** The execution workspace the preview runs in — also its address in the proxy path. */
  workspaceId: string;
  status: PreviewEnvironmentStatus;
  /** Operator-facing link, e.g. "/_preview/<workspace id>/". Null until it is ready. */
  previewUrl: string | null;
  ref: PreviewEnvironmentRef | null;
  /** Plain-language sentence for the card. Always set. */
  message: string;
  /** Why it failed, in plain language. Only set when status is "failed". */
  failureReason: string | null;
  startedAt: string | null;
  lastUsedAt: string | null;
  /** When this preview is thrown away if nobody opens it again. */
  idleTimeoutMinutes: number;
}

/**
 * What the operator is told when there is no preview at all for a card — the
 * common case, and never an error.
 */
export interface PreviewEnvironmentAvailability {
  /** True when "Preview this before approving" should do something. */
  canStart: boolean;
  /** Why it cannot be started, in plain language. Null when it can. */
  blockedReason: string | null;
  ref: PreviewEnvironmentRef | null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The only two kinds of card that get a preview: a merge waiting to land, and
 * a deploy waiting to ship. Anything else (hiring, credentials, a budget
 * override) has no code to look at.
 */
export function isPreviewableApprovalPayload(
  type: string | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (type !== "request_board_approval") return false;
  const kind = nonEmpty(payload?.kind);
  return kind === "merge_pr" || kind === "deploy";
}

/**
 * Which exact code a preview of this card should run.
 *
 * A deploy card already pins the commit it would ship, so the preview runs
 * that commit and nothing else. A merge card points at a branch that is still
 * moving, so the preview runs the tip of that branch — which is what the
 * operator would be merging if they said yes right now.
 */
export function readApprovalPreviewRef(
  payload: Record<string, unknown> | null | undefined,
): PreviewEnvironmentRef | null {
  const kind = nonEmpty(payload?.kind);
  if (kind === "deploy") {
    const commit = nonEmpty(payload?.commit);
    if (commit) {
      return { kind: "commit", value: commit, label: `the exact version ${commit.slice(0, 7)}` };
    }
    const sourceBranch = nonEmpty(payload?.sourceBranch);
    if (sourceBranch) {
      return { kind: "branch", value: sourceBranch, label: `the latest code on ${sourceBranch}` };
    }
    return null;
  }
  if (kind === "merge_pr") {
    const branch = nonEmpty(payload?.branch);
    if (branch) {
      return { kind: "branch", value: branch, label: `the latest code on ${branch}` };
    }
    const commit = nonEmpty(payload?.commit);
    if (commit) {
      return { kind: "commit", value: commit, label: `the exact version ${commit.slice(0, 7)}` };
    }
    return null;
  }
  return null;
}

/** The operator-facing link for a running preview. */
export function buildPreviewProxyPath(workspaceId: string): string {
  return `${PREVIEW_PROXY_PATH_PREFIX}/${workspaceId}/`;
}

/**
 * Split a proxy request path into the workspace it belongs to and the path
 * inside the previewed app.
 *
 * This is the one place that decides what the proxy forwards, so it is
 * deliberately strict: the workspace id may only be the characters an id is
 * made of, and the forwarded path always starts with a single "/" — a caller
 * can never walk out of the preview with "..", a backslash, or a second host.
 * Returns null when the path is not a preview path at all.
 */
export function parsePreviewProxyPath(
  rawPath: string,
): { workspaceId: string; forwardPath: string } | null {
  if (typeof rawPath !== "string" || !rawPath.startsWith(`${PREVIEW_PROXY_PATH_PREFIX}/`)) return null;
  const remainder = rawPath.slice(PREVIEW_PROXY_PATH_PREFIX.length + 1);
  const slashIndex = remainder.indexOf("/");
  const workspaceId = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
  const rest = slashIndex === -1 ? "" : remainder.slice(slashIndex + 1);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(workspaceId)) return null;
  return { workspaceId, forwardPath: normalizePreviewForwardPath(rest) };
}

/**
 * Turn the part of the URL after the workspace id into the path the previewed
 * app is asked for. Anything that could escape the preview — a "..", an
 * absolute or protocol-relative URL, a backslash — is dropped rather than
 * forwarded, so the proxy can only ever reach paths under the one local port
 * it was given.
 */
export function normalizePreviewForwardPath(rest: string): string {
  const raw = typeof rest === "string" ? rest : "";
  const withoutQuery = raw.split("#")[0]!.split("?")[0]!;
  const segments = withoutQuery
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  return `/${segments.join("/")}`;
}

/**
 * The one sentence the card shows about a preview. Never jargon, never a
 * status code — what is happening and what the operator can do about it.
 */
export function describePreviewStatus(input: {
  status: PreviewEnvironmentStatus;
  refLabel?: string | null;
  failureReason?: string | null;
  idleTimeoutMinutes?: number;
}): string {
  const what = input.refLabel ? ` of ${input.refLabel}` : "";
  switch (input.status) {
    case "starting":
      return `Starting a copy${what} so you can try it. This usually takes under a minute.`;
    case "ready": {
      const minutes = input.idleTimeoutMinutes ?? PREVIEW_DEFAULT_IDLE_TIMEOUT_MINUTES;
      return `A copy${what} is running. Open it, click around, then decide. It shuts itself down after ${minutes} minutes without use, and as soon as you decide this card.`;
    }
    case "failed":
      return input.failureReason
        ? `The copy${what} did not start: ${input.failureReason}`
        : `The copy${what} did not start.`;
    case "stopped":
    default:
      return "Nothing is running for this branch yet.";
  }
}

/** The page the proxy shows when there is nothing to proxy to. */
export const PREVIEW_NOT_RUNNING_HEADLINE = "Nothing is running for this branch yet";

export function previewNotRunningBody(detail?: string | null): string {
  return detail
    ? `${detail} Go back to the approval and use "Preview this before approving" to start one.`
    : 'Go back to the approval and use "Preview this before approving" to start one.';
}

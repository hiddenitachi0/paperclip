import { z } from "zod";

/**
 * DUR-128: the allowlist of actions a delegated operator credential may be
 * scoped to reach. Deliberately limited to low-risk recovery actions --
 * approving a merge or a deploy is operator judgement and must never appear
 * here. Routes still gate on this list server-side (assertBoardOrDelegate in
 * server/src/routes/authz.ts); this allowlist only bounds what a token can be
 * *created* with, it is not itself the enforcement point.
 */
export const DELEGATE_TOKEN_SCOPES = [
  "agent.clear_error",
  "agent.resume",
  "issue.scheduled_retry_retry_now",
] as const;

export type DelegateTokenScope = (typeof DELEGATE_TOKEN_SCOPES)[number];

const delegateTokenScopeSet: ReadonlySet<string> = new Set(DELEGATE_TOKEN_SCOPES);

export function isDelegateTokenScope(value: unknown): value is DelegateTokenScope {
  return typeof value === "string" && delegateTokenScopeSet.has(value);
}

/** Filters to known scopes, drops anything else, and dedups. */
export function normalizeDelegateTokenScopes(value: unknown): DelegateTokenScope[] {
  if (!Array.isArray(value)) return [];
  const scopes = new Set<DelegateTokenScope>();
  for (const item of value) {
    if (isDelegateTokenScope(item)) scopes.add(item);
  }
  return Array.from(scopes);
}

export const createDelegateTokenSchema = z.object({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(z.enum(DELEGATE_TOKEN_SCOPES)).min(1),
  expiresAt: z.string().datetime().optional().nullable(),
});

export type CreateDelegateToken = z.infer<typeof createDelegateTokenSchema>;

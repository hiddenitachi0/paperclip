import { z } from "zod";

/**
 * DUR-3977 acceptance item 2: a per-company service token for server-to-server
 * calls (Nordstrand's dashboard calling the transform endpoint). Created and
 * revoked by a board user in Paperclip's company settings; an agent can never
 * mint one, because the routes are `assertBoard` only.
 *
 * The token value itself appears exactly once, in the 201 response to the
 * create call. It is stored as a SHA-256 hash and is never read back, never
 * logged, and never put in an error message or an activity row.
 */

/**
 * The allowlist of things a company service token may be scoped to reach.
 * Deliberately shaped exactly like DELEGATE_TOKEN_SCOPES (DUR-128): a token
 * carries an explicit list, routes name the scope they need, and a scope that
 * is not in the list cannot be minted.
 *
 * This is the FIRST credential Paperclip issues to a system outside itself,
 * so the list is the written-down answer to "what can the Nordstrand
 * dashboard reach": exactly the Lane A transform lane — the stateless rewrite
 * call and the read that tells the caller which quick agents it may name.
 * Nothing else. Adding an entry here is a deliberate decision, not a side
 * effect of which assert helper some other route happens to use.
 */
export const SERVICE_TOKEN_SCOPES = ["lane_a:transform"] as const;

export type ServiceTokenScope = (typeof SERVICE_TOKEN_SCOPES)[number];

const serviceTokenScopeSet: ReadonlySet<string> = new Set(SERVICE_TOKEN_SCOPES);

export function isServiceTokenScope(value: unknown): value is ServiceTokenScope {
  return typeof value === "string" && serviceTokenScopeSet.has(value);
}

/**
 * Filters to known scopes, drops anything else, and dedups. A row written by
 * an older or newer build, or hand-edited, can therefore never widen what a
 * token reaches — an unrecognised scope string is simply not a scope.
 */
export function normalizeServiceTokenScopes(value: unknown): ServiceTokenScope[] {
  if (!Array.isArray(value)) return [];
  const scopes = new Set<ServiceTokenScope>();
  for (const item of value) {
    if (isServiceTokenScope(item)) scopes.add(item);
  }
  return Array.from(scopes);
}

export const createCompanyServiceTokenSchema = z.object({
  /** What the operator calls it, e.g. "Nordstrand dashboard". */
  name: z.string().trim().min(1).max(120),
  /**
   * What this token may reach. Defaults to the transform lane because that is
   * the only thing a service token exists for today; it is still written onto
   * the row explicitly so the grant is a stored fact, not an assumption.
   */
  scopes: z
    .array(z.enum(SERVICE_TOKEN_SCOPES))
    .min(1)
    .optional()
    .default([...SERVICE_TOKEN_SCOPES]),
  /** Optional expiry. Null/absent means it lasts until revoked. */
  expiresAt: z.coerce.date().nullable().optional(),
});

export type CreateCompanyServiceToken = z.infer<typeof createCompanyServiceTokenSchema>;

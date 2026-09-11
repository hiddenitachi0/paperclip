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
export const createCompanyServiceTokenSchema = z.object({
  /** What the operator calls it, e.g. "Nordstrand dashboard". */
  name: z.string().trim().min(1).max(120),
  /** Optional expiry. Null/absent means it lasts until revoked. */
  expiresAt: z.coerce.date().nullable().optional(),
});

export type CreateCompanyServiceToken = z.infer<typeof createCompanyServiceTokenSchema>;

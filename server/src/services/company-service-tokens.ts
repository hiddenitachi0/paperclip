import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyServiceTokens } from "@paperclipai/db";
import { normalizeServiceTokenScopes, type ServiceTokenScope } from "@paperclipai/shared";
import { hashBearerToken } from "./board-auth.js";

/**
 * DUR-3977: per-company machine credentials for server-to-server calls.
 *
 * Everything about the token value is deliberately one-way:
 *   - it is generated here and returned to the caller exactly once, by
 *     `createToken`,
 *   - only `hashBearerToken(token)` (SHA-256, the same helper board API keys
 *     and delegate tokens use) is written to the database,
 *   - no read path in this file returns `tokenHash`, let alone the token, and
 *   - nothing in this file logs, and nothing puts a token value into an error
 *     message. `findByToken` returns null for every failure — wrong token,
 *     revoked token, expired token — so an error can never distinguish them.
 *
 * Company scoping is NOT taken from anything the caller sends: the row itself
 * carries `companyId`, and that is the only company the credential can ever
 * act for.
 */

/** `pcp_service_` prefix so an accidentally-pasted token is recognisable as a Paperclip service token. */
export function createCompanyServiceTokenValue() {
  return `pcp_service_${randomBytes(24).toString("hex")}`;
}

export type CompanyServiceTokenSummary = {
  id: string;
  companyId: string;
  name: string;
  scopes: ServiceTokenScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

/** Every field except the hash. Used for every list/read response. */
const summaryColumns = {
  id: companyServiceTokens.id,
  companyId: companyServiceTokens.companyId,
  name: companyServiceTokens.name,
  scopes: companyServiceTokens.scopes,
  createdAt: companyServiceTokens.createdAt,
  lastUsedAt: companyServiceTokens.lastUsedAt,
  revokedAt: companyServiceTokens.revokedAt,
  expiresAt: companyServiceTokens.expiresAt,
};

/**
 * Every read path runs the stored scopes through the shared allowlist, so a
 * scope string this build does not know about (an older/newer row, a hand
 * edit) can never widen what a token reaches — it is simply dropped.
 */
function withNormalizedScopes<T extends { scopes: unknown }>(row: T): Omit<T, "scopes"> & { scopes: ServiceTokenScope[] } {
  return { ...row, scopes: normalizeServiceTokenScopes(row.scopes) };
}

export function companyServiceTokenService(db: Db) {
  async function createToken(input: {
    companyId: string;
    name: string;
    createdByUserId: string | null;
    /** What this token may reach. Normalized against the shared allowlist first. */
    scopes: ServiceTokenScope[];
    expiresAt?: Date | null;
  }): Promise<CompanyServiceTokenSummary & { token: string }> {
    const token = createCompanyServiceTokenValue();
    const scopes = normalizeServiceTokenScopes(input.scopes);
    const created = await db
      .insert(companyServiceTokens)
      .values({
        companyId: input.companyId,
        name: input.name.trim(),
        tokenHash: hashBearerToken(token),
        scopes,
        createdByUserId: input.createdByUserId,
        expiresAt: input.expiresAt ?? null,
      })
      .returning(summaryColumns)
      .then((rows) => rows[0]!);

    // The only place the token value ever leaves this module.
    return { ...withNormalizedScopes(created), token };
  }

  async function listTokens(
    companyId: string,
    opts: { includeInactive?: boolean } = {},
  ): Promise<CompanyServiceTokenSummary[]> {
    const conditions = [eq(companyServiceTokens.companyId, companyId)];
    if (!opts.includeInactive) {
      conditions.push(isNull(companyServiceTokens.revokedAt));
      const stillValid = or(
        isNull(companyServiceTokens.expiresAt),
        gt(companyServiceTokens.expiresAt, new Date()),
      );
      if (stillValid) conditions.push(stillValid);
    }
    const rows = await db
      .select(summaryColumns)
      .from(companyServiceTokens)
      .where(and(...conditions))
      .orderBy(sql`${companyServiceTokens.createdAt} desc`);
    return rows.map(withNormalizedScopes);
  }

  async function getTokenForCompany(
    tokenId: string,
    companyId: string,
  ): Promise<CompanyServiceTokenSummary | null> {
    return db
      .select(summaryColumns)
      .from(companyServiceTokens)
      .where(and(eq(companyServiceTokens.id, tokenId), eq(companyServiceTokens.companyId, companyId)))
      .then((rows) => (rows[0] ? withNormalizedScopes(rows[0]) : null));
  }

  /**
   * Revoking is scoped by companyId as well as id, so a board user with
   * access to company A cannot revoke company B's token by guessing its uuid.
   */
  async function revokeToken(input: {
    tokenId: string;
    companyId: string;
    revokedByUserId: string | null;
  }): Promise<CompanyServiceTokenSummary | null> {
    const now = new Date();
    return db
      .update(companyServiceTokens)
      .set({ revokedAt: now, revokedByUserId: input.revokedByUserId })
      .where(
        and(
          eq(companyServiceTokens.id, input.tokenId),
          eq(companyServiceTokens.companyId, input.companyId),
          isNull(companyServiceTokens.revokedAt),
        ),
      )
      .returning(summaryColumns)
      .then((rows) => (rows[0] ? withNormalizedScopes(rows[0]) : null));
  }

  /**
   * Authentication lookup. Returns the row (id, companyId, name and scopes —
   * never the hash) or null. A revoked or expired token is null, identical to
   * a token that never existed: the caller must not be able to tell those
   * apart.
   */
  async function findByToken(
    token: string,
  ): Promise<{ id: string; companyId: string; name: string; scopes: ServiceTokenScope[] } | null> {
    if (!token.startsWith("pcp_service_")) return null;
    const now = new Date();
    const row = await db
      .select({
        id: companyServiceTokens.id,
        companyId: companyServiceTokens.companyId,
        name: companyServiceTokens.name,
        scopes: companyServiceTokens.scopes,
        expiresAt: companyServiceTokens.expiresAt,
      })
      .from(companyServiceTokens)
      .where(
        and(
          eq(companyServiceTokens.tokenHash, hashBearerToken(token)),
          isNull(companyServiceTokens.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      scopes: normalizeServiceTokenScopes(row.scopes),
    };
  }

  async function touchToken(tokenId: string): Promise<void> {
    await db
      .update(companyServiceTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(companyServiceTokens.id, tokenId));
  }

  return { createToken, listTokens, getTokenForCompany, revokeToken, findByToken, touchToken };
}

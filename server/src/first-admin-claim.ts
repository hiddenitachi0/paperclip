import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceUserRoles, withCompanyScopeBypass } from "@paperclipai/db";

type FirstAdminTransaction = Pick<Db, "execute" | "select" | "insert" | "update">;

export type FirstAdminClaimResult<T = unknown> =
  | {
      status: "claimed";
      userId: string;
      value: T | null;
    }
  | {
      status: "already_claimed";
      existingUserId: string | null;
      value: null;
    };

export async function claimFirstInstanceAdmin<T = unknown>(
  // DUR-381 (DUR-277 Wave 5b): must be the RAW (unwrapped) db -- this runs
  // under company-scope bypass (no company exists yet at first-admin-claim
  // time), and withCompanyScopeBypass needs a fresh reserved connection to
  // verify paperclip_app_bypass role membership, not a request-scoped proxy.
  rawDb: Db,
  input: {
    userId: string;
    onClaim?: (tx: FirstAdminTransaction) => Promise<T>;
  },
): Promise<FirstAdminClaimResult<T>> {
  return withCompanyScopeBypass(rawDb, {
    reason: "first instance-admin bootstrap claim runs before any company exists",
  }, async (tx) => {
    await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);

    const existingAdmin = await tx
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows[0] ?? null);

    if (existingAdmin) {
      return {
        status: "already_claimed" as const,
        existingUserId: existingAdmin.userId ?? null,
        value: null,
      };
    }

    await tx.insert(instanceUserRoles).values({
      userId: input.userId,
      role: "instance_admin",
    });

    const value = input.onClaim ? await input.onClaim(tx) : null;
    return {
      status: "claimed" as const,
      userId: input.userId,
      value,
    };
  });
}

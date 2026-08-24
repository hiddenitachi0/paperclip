// DUR-146 Stage 1: seed the two starter jobs Filip asked for on the DUR
// board (paperclip-fork's own company) — "Boss" and "Developer", differing
// only in whether they carry deploys:request. Idempotent by role key, so
// this is safe to run on every server startup.
//
// This does NOT backfill deploys:request onto any existing agent. Filip's
// 21 Aug ruling on DUR-65 is explicit: "Start with nobody holding it and
// let Filip assign it." Assigning the Boss job to an agent is the only way
// it gains that right.
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { createRole, listRoles } from "./agent-roles.js";

export const DUR_COMPANY_ID = "7600f03c-c836-4326-8d48-c801813c3a87";

export async function seedDurStarterJobs(db: Db): Promise<{ created: string[] }> {
  // The DUR company row does not exist on every instance this server code
  // runs on (fresh onboarding, e2e tests, other operators' deployments of
  // this fork). Skip silently rather than letting the FK violation on
  // company_agent_roles.company_id crash server startup entirely.
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, DUR_COMPANY_ID));
  if (!company) {
    return { created: [] };
  }

  const existing = await listRoles(db, DUR_COMPANY_ID);
  const existingKeys = new Set(existing.map((role) => role.key));
  const created: string[] = [];

  if (!existingKeys.has("boss")) {
    await createRole(db, DUR_COMPANY_ID, {
      name: "Boss",
      description:
        "Runs a company or department. Can ask Filip to deploy finished work or merge a pull request — " +
        "never approves either alone; every deploy and every merge still stops at Filip.",
      defaultGrants: [
        { permissionKey: "deploys:request", scope: null },
        { permissionKey: "merges:request", scope: null },
      ],
    });
    created.push("boss");
  }

  if (!existingKeys.has("developer")) {
    await createRole(db, DUR_COMPANY_ID, {
      name: "Developer",
      description:
        "Builds and ships features. Can ask Filip to merge a finished pull request. Cannot ask for a deploy " +
        "— that stays with the Boss job.",
      defaultGrants: [{ permissionKey: "merges:request", scope: null }],
    });
    created.push("developer");
  }

  return { created };
}

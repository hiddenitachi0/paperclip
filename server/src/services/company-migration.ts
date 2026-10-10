import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  companies,
  companySecrets,
  dataConnections,
  instanceClaudeAuth,
  projects,
  routines,
  withCompanyScope,
} from "@paperclipai/db";
import {
  companyMigrationNameMatches,
  worstMigrationCheckStatus,
  type CompanyMarkMigratedResult,
  type CompanyMigrationCheckItem,
  type CompanyMigrationCheckSection,
  type CompanyMigrationCheckStatus,
  type CompanyMigrationVerifyReport,
  type CompanyUndoMigratedResult,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  CLAUDE_AUTH_FALLBACK_ENV_KEY,
  CLAUDE_AUTH_SETTINGS_PATH,
  buildClaudeAuthOperatorMessage,
  processEnvHasClaudeCredential,
} from "./claude-credential-source.js";
import { classifyClaudeAuthHealth } from "./instance-claude-auth.js";

/**
 * Franchise migration, phase B (see packages/shared/src/company-migration.ts).
 *
 * verifyDestination is strictly read-only: it only SELECTs, never calls a
 * provider, never spawns the Claude CLI and never spends money. The Claude
 * check reuses the same resolution order the heartbeat uses at run time
 * (claude-credential-source.ts): the agent's own token wins, then the shared
 * instance sign-in, then a token on the server process itself.
 *
 * markMigrated / undoMigrated pause and resume; they never delete anything.
 */

const INSTANCE_CLAUDE_AUTH_SINGLETON_KEY = "default";

const CLAUDE_CREDENTIAL_ENV_KEYS = [
  CLAUDE_AUTH_FALLBACK_ENV_KEY,
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
] as const;

type SecretRow = { id: string; status: string };

type EnvRef =
  | { kind: "value"; key: string }
  | { kind: "secret"; key: string; secretId: string }
  | { kind: "empty"; key: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvBindings(env: unknown): EnvRef[] {
  if (!isRecord(env)) return [];
  const out: EnvRef[] = [];
  for (const [key, binding] of Object.entries(env)) {
    if (typeof binding === "string") {
      out.push(binding.trim().length > 0 ? { kind: "value", key } : { kind: "empty", key });
    } else if (typeof binding === "boolean") {
      out.push(binding ? { kind: "value", key } : { kind: "empty", key });
    } else if (isRecord(binding) && binding.type === "secret_ref" && typeof binding.secretId === "string") {
      out.push({ kind: "secret", key, secretId: binding.secretId });
    } else if (isRecord(binding) && binding.type === "plain") {
      const value = binding.value;
      out.push(typeof value === "string" && value.trim().length > 0 ? { kind: "value", key } : { kind: "empty", key });
    }
  }
  return out;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function section(
  key: CompanyMigrationCheckSection["key"],
  title: string,
  summary: string,
  items: CompanyMigrationCheckItem[],
  forced?: CompanyMigrationCheckStatus,
): CompanyMigrationCheckSection {
  return {
    key,
    title,
    status: forced ?? worstMigrationCheckStatus(items.map((item) => item.status)),
    summary,
    items,
  };
}

export interface CompanyMigrationServiceDeps {
  /** Read-only instance-wide lookups (the shared Claude sign-in row). */
  instanceDb?: Db;
  now?: () => Date;
  processEnv?: NodeJS.ProcessEnv;
}

export function companyMigrationService(db: Db, deps: CompanyMigrationServiceDeps = {}) {
  const instanceDb = deps.instanceDb ?? db;
  const now = deps.now ?? (() => new Date());

  async function readInstanceClaudeHealth() {
    const row = await instanceDb
      .select()
      .from(instanceClaudeAuth)
      .where(eq(instanceClaudeAuth.singletonKey, INSTANCE_CLAUDE_AUTH_SINGLETON_KEY))
      .limit(1)
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    if (!row) return { configured: false as const };
    return { configured: true as const, ...classifyClaudeAuthHealth(row, now()) };
  }

  async function verifyDestination(companyId: string): Promise<CompanyMigrationVerifyReport> {
    const company = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    const [agentRows, projectRows, routineRows, secretRows, connectionRows, instanceClaude] = await Promise.all([
      db
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), notInArray(agents.status, ["terminated"]))),
      db
        .select({ id: projects.id, name: projects.name, env: projects.env, archivedAt: projects.archivedAt })
        .from(projects)
        .where(eq(projects.companyId, companyId)),
      db
        .select({
          id: routines.id,
          title: routines.title,
          status: routines.status,
          assigneeAgentId: routines.assigneeAgentId,
          env: routines.env,
        })
        .from(routines)
        .where(eq(routines.companyId, companyId)),
      db
        .select({ id: companySecrets.id, status: companySecrets.status })
        .from(companySecrets)
        .where(eq(companySecrets.companyId, companyId)),
      db
        .select({
          id: dataConnections.id,
          name: dataConnections.name,
          kind: dataConnections.kind,
          status: dataConnections.status,
          credentialSecretId: dataConnections.credentialSecretId,
          lastCheckOk: dataConnections.lastCheckOk,
        })
        .from(dataConnections)
        .where(eq(dataConnections.companyId, companyId)),
      readInstanceClaudeHealth(),
    ]);

    const secretsById = new Map<string, SecretRow>(secretRows.map((row) => [row.id, row]));
    const secretUsable = (secretId: string) => secretsById.get(secretId)?.status === "active";
    const agentsById = new Map(agentRows.map((row) => [row.id, row]));
    const sections: CompanyMigrationCheckSection[] = [];

    // ── Agents ────────────────────────────────────────────────────────────
    const agentItems: CompanyMigrationCheckItem[] = agentRows.map((agent) => {
      if (agent.status === "pending_approval") {
        return {
          label: agent.name,
          status: "warning",
          detail: `${agent.name} is here but waiting for approval before it can work.`,
          fixHint: "Approve it on the Agents page.",
        };
      }
      if (agent.status === "error") {
        return {
          label: agent.name,
          status: "problem",
          detail: `${agent.name} is here but stopped with an error.`,
          fixHint: "Open the agent to see what went wrong, then resume it.",
        };
      }
      if (agent.status === "paused") {
        return {
          label: agent.name,
          status: "warning",
          detail: `${agent.name} is here but paused.`,
          fixHint: "Resume it on the agent's page when you are ready for it to work here.",
        };
      }
      return { label: agent.name, status: "ok", detail: `${agent.name} is here and ready.`, fixHint: null };
    });
    sections.push(
      section(
        "agents",
        "Agents arrived",
        agentRows.length === 0
          ? "No agents are here yet."
          : `${plural(agentRows.length, "agent")} are here.`,
        agentRows.length === 0
          ? [{
              label: "Agents",
              status: "problem",
              detail: "This company has no agents.",
              fixHint: "Import the company again with its agents ticked.",
            }]
          : agentItems,
      ),
    );

    // ── Claude sign-in ────────────────────────────────────────────────────
    const claudeAgents = agentRows.filter((agent) => agent.adapterType === "claude_local");
    const processHasToken = processEnvHasClaudeCredential(deps.processEnv ?? process.env);
    const claudeItems: CompanyMigrationCheckItem[] = claudeAgents.map((agent) => {
      const config = isRecord(agent.adapterConfig) ? agent.adapterConfig : {};
      const own = readEnvBindings(config.env).filter((ref) =>
        (CLAUDE_CREDENTIAL_ENV_KEYS as readonly string[]).includes(ref.key) && ref.kind !== "empty",
      );
      if (own.length > 0) {
        const brokenSecret = own.find((ref) => ref.kind === "secret" && !secretUsable(ref.secretId));
        if (brokenSecret) {
          return {
            label: agent.name,
            status: "problem",
            detail: `${agent.name} has its own Claude sign-in, but the saved token it points to did not arrive here.`,
            fixHint:
              "Open the agent, go to Configuration and enter its Claude token again — or remove it so the agent uses the shared sign-in.",
          };
        }
        return {
          label: agent.name,
          status: "ok",
          detail: `${agent.name} uses its own Claude sign-in, and it is in place.`,
          fixHint: null,
        };
      }
      if (instanceClaude.configured) {
        if (instanceClaude.health === "expired" || instanceClaude.health === "check_failed") {
          return {
            label: agent.name,
            status: "problem",
            detail: `${agent.name} uses the shared Claude sign-in, and that sign-in has stopped working.`,
            fixHint: `Sign in again under ${CLAUDE_AUTH_SETTINGS_PATH}.`,
          };
        }
        if (instanceClaude.health === "expiring_soon") {
          return {
            label: agent.name,
            status: "warning",
            detail: `${agent.name} uses the shared Claude sign-in, which runs out soon.`,
            fixHint: `Renew it under ${CLAUDE_AUTH_SETTINGS_PATH}.`,
          };
        }
        return {
          label: agent.name,
          status: "ok",
          detail: `${agent.name} uses the shared Claude sign-in, and it works.`,
          fixHint: null,
        };
      }
      if (processHasToken) {
        return {
          label: agent.name,
          status: "warning",
          detail: `${agent.name} would use a Claude token set on the server itself.`,
          fixHint: `That works, but it is easier to keep up to date if you sign in under ${CLAUDE_AUTH_SETTINGS_PATH}.`,
        };
      }
      return {
        label: agent.name,
        status: "problem",
        detail: buildClaudeAuthOperatorMessage({ source: "none", agentName: agent.name }),
        fixHint: `Sign in once under ${CLAUDE_AUTH_SETTINGS_PATH}.`,
      };
    });
    const otherAgents = agentRows.length - claudeAgents.length;
    sections.push(
      section(
        "claude_login",
        "Claude sign-in",
        claudeAgents.length === 0
          ? "No Claude agents here, so there is no Claude sign-in to check."
          : `Checked ${plural(claudeAgents.length, "Claude agent")}${
              otherAgents > 0 ? ` (${plural(otherAgents, "other agent")} use a different AI and are not checked here)` : ""
            }. Nothing was sent to Claude.`,
        claudeItems,
      ),
    );

    // ── Secrets ───────────────────────────────────────────────────────────
    const secretItems: CompanyMigrationCheckItem[] = [];
    let boundCount = 0;
    const checkBindings = (owner: string, ownerHint: string, env: unknown) => {
      for (const ref of readEnvBindings(env)) {
        if (ref.kind !== "secret") continue;
        boundCount += 1;
        const secret = secretsById.get(ref.secretId);
        if (!secret) {
          secretItems.push({
            label: `${owner}: ${ref.key}`,
            status: "problem",
            detail: `${owner} needs the secret ${ref.key}, but it did not arrive here.`,
            fixHint: `${ownerHint} and enter ${ref.key} again.`,
          });
        } else if (secret.status !== "active") {
          secretItems.push({
            label: `${owner}: ${ref.key}`,
            status: "problem",
            detail: `${owner} needs the secret ${ref.key}, but it is switched off (${secret.status}).`,
            fixHint: `Turn it back on under Company settings > Secrets, or ${ownerHint.toLowerCase()} and enter ${ref.key} again.`,
          });
        }
      }
    };
    for (const agent of agentRows) {
      const config = isRecord(agent.adapterConfig) ? agent.adapterConfig : {};
      checkBindings(agent.name, "Open the agent, go to Configuration,", config.env);
    }
    for (const project of projectRows) {
      if (project.archivedAt) continue;
      checkBindings(`Project ${project.name}`, "Open the project settings", project.env);
    }
    for (const routine of routineRows) {
      if (routine.status === "archived") continue;
      checkBindings(`Routine ${routine.title}`, "Open the routine", routine.env);
    }
    const activeSecrets = secretRows.filter((row) => row.status === "active").length;
    sections.push(
      section(
        "secrets",
        "Secrets",
        secretItems.length === 0
          ? `${plural(activeSecrets, "secret")} saved here; all ${plural(boundCount, "setting")} that use one can find it.`
          : `${plural(secretItems.length, "setting")} point to a secret that is not here.`,
        secretItems.length === 0
          ? [{
              label: "Secrets",
              status: "ok",
              detail: boundCount === 0
                ? "Nothing here uses a saved secret."
                : `Every one of the ${plural(boundCount, "setting")} that use a saved secret can find it.`,
              fixHint: null,
            }]
          : secretItems,
      ),
    );

    // ── Projects ──────────────────────────────────────────────────────────
    const liveProjects = projectRows.filter((project) => !project.archivedAt);
    sections.push(
      section(
        "projects",
        "Projects",
        liveProjects.length === 0 ? "No projects are here." : `${plural(liveProjects.length, "project")} are here.`,
        liveProjects.length === 0
          ? [{
              label: "Projects",
              status: "warning",
              detail: "This company has no projects.",
              fixHint: "If the old company had projects, import again with projects ticked.",
            }]
          : liveProjects.map((project) => ({
              label: project.name,
              status: "ok" as const,
              detail: `${project.name} is here.`,
              fixHint: null,
            })),
      ),
    );

    // ── Routines ──────────────────────────────────────────────────────────
    const liveRoutines = routineRows.filter((routine) => routine.status !== "archived");
    const routineItems: CompanyMigrationCheckItem[] = liveRoutines.map((routine) => {
      const assignee = routine.assigneeAgentId ? agentsById.get(routine.assigneeAgentId) : null;
      if (routine.assigneeAgentId && !assignee) {
        return {
          label: routine.title,
          status: "problem",
          detail: `${routine.title} is assigned to an agent that is not here.`,
          fixHint: "Open the routine and pick an agent from this company.",
        };
      }
      if (!routine.assigneeAgentId) {
        return {
          label: routine.title,
          status: "warning",
          detail: `${routine.title} has no agent to do it.`,
          fixHint: "Open the routine and pick an agent.",
        };
      }
      if (routine.status === "paused") {
        return {
          label: routine.title,
          status: "warning",
          detail: `${routine.title} is here but paused.`,
          fixHint: "Turn it on when you are ready for it to run here.",
        };
      }
      return { label: routine.title, status: "ok", detail: `${routine.title} is here and on.`, fixHint: null };
    });
    sections.push(
      section(
        "routines",
        "Routines",
        liveRoutines.length === 0 ? "No routines are here." : `${plural(liveRoutines.length, "routine")} are here.`,
        liveRoutines.length === 0
          ? [{
              label: "Routines",
              status: "ok",
              detail: "This company has no routines. That is fine if the old one had none.",
              fixHint: null,
            }]
          : routineItems,
      ),
    );

    // ── Data connections ──────────────────────────────────────────────────
    const connectionItems: CompanyMigrationCheckItem[] = connectionRows.map((connection) => {
      if (!secretUsable(connection.credentialSecretId)) {
        return {
          label: connection.name,
          status: "problem",
          detail: `${connection.name} is here, but its key or password is missing.`,
          fixHint: "Open Connections and enter the key or password again.",
        };
      }
      if (connection.status === "error" || connection.lastCheckOk === false) {
        return {
          label: connection.name,
          status: "problem",
          detail: `${connection.name} is here, but its last test failed.`,
          fixHint: "Open Connections and test it again; re-enter the key if it still fails.",
        };
      }
      if (connection.status !== "active") {
        return {
          label: connection.name,
          status: "warning",
          detail: `${connection.name} is here but not switched on yet (${connection.status}).`,
          fixHint: "Open Connections, test it and switch it on.",
        };
      }
      return { label: connection.name, status: "ok", detail: `${connection.name} is here and on.`, fixHint: null };
    });
    sections.push(
      section(
        "data_connections",
        "Data connections",
        connectionRows.length === 0
          ? "No data connections are here. They do not travel in the export file."
          : `${plural(connectionRows.length, "data connection")} are here.`,
        connectionRows.length === 0
          ? [{
              label: "Data connections",
              status: "warning",
              detail: "This company has no data connections (Shopify, file servers and so on).",
              fixHint: "If the old company had any, add them again under Company settings > Connections.",
            }]
          : connectionItems,
      ),
    );

    return {
      companyId: company.id,
      companyName: company.name,
      checkedAt: now().toISOString(),
      status: worstMigrationCheckStatus(sections.map((entry) => entry.status)),
      sections,
    };
  }

  async function markMigrated(
    companyId: string,
    input: { destinationUrl: string; confirmCompanyName: string; userId: string | null },
  ): Promise<CompanyMarkMigratedResult> {
    return withCompanyScope(db, companyId, async (tx) => {
      const company = await tx
        .select({ id: companies.id, name: companies.name, migratedToUrl: companies.migratedToUrl })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      if (!companyMigrationNameMatches(input.confirmCompanyName, company.name)) {
        throw unprocessable(`Type the company's name exactly ("${company.name}") to confirm.`);
      }
      if (company.migratedToUrl) {
        throw conflict("This company is already marked as moved. Undo that first if the address changed.");
      }
      const at = now();
      const pausedAgents = await tx
        .update(agents)
        .set({ status: "paused", pauseReason: "company_migrated", pausedAt: at, updatedAt: at })
        .where(and(
          eq(agents.companyId, companyId),
          notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
        ))
        .returning({ id: agents.id });
      const pausedRoutines = await tx
        .update(routines)
        .set({ status: "paused", updatedAt: at })
        .where(and(eq(routines.companyId, companyId), eq(routines.status, "active")))
        .returning({ id: routines.id });
      // Wakeups that were queued but not picked up yet would otherwise start a
      // run the moment someone resumes an agent; mark them cancelled (the rows
      // stay, nothing is deleted).
      await tx
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          error: "Cancelled because the company was marked as moved to another Paperclip",
          finishedAt: at,
          updatedAt: at,
        })
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          isNull(agentWakeupRequests.runId),
        ));
      await tx
        .update(companies)
        .set({
          migratedToUrl: input.destinationUrl,
          migratedAt: at,
          migratedByUserId: input.userId,
          migrationPausedRoutineIds: pausedRoutines.map((row) => row.id),
          updatedAt: at,
        })
        .where(eq(companies.id, companyId));
      return {
        companyId,
        migratedToUrl: input.destinationUrl,
        migratedAt: at.toISOString(),
        migratedByUserId: input.userId,
        agentsPaused: pausedAgents.length,
        routinesPaused: pausedRoutines.length,
      };
    });
  }

  async function undoMigrated(companyId: string): Promise<CompanyUndoMigratedResult> {
    return withCompanyScope(db, companyId, async (tx) => {
      const company = await tx
        .select({
          id: companies.id,
          migratedToUrl: companies.migratedToUrl,
          migrationPausedRoutineIds: companies.migrationPausedRoutineIds,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      if (!company.migratedToUrl) throw conflict("This company is not marked as moved.");
      const at = now();
      const resumedAgents = await tx
        .update(agents)
        .set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: at })
        .where(and(
          eq(agents.companyId, companyId),
          eq(agents.status, "paused"),
          eq(agents.pauseReason, "company_migrated"),
        ))
        .returning({ id: agents.id });
      const routineIds = Array.isArray(company.migrationPausedRoutineIds)
        ? company.migrationPausedRoutineIds.filter((id): id is string => typeof id === "string")
        : [];
      const resumedRoutines = routineIds.length === 0
        ? []
        : await tx
          .update(routines)
          .set({ status: "active", updatedAt: at })
          .where(and(
            eq(routines.companyId, companyId),
            eq(routines.status, "paused"),
            inArray(routines.id, routineIds),
          ))
          .returning({ id: routines.id });
      await tx
        .update(companies)
        .set({
          migratedToUrl: null,
          migratedAt: null,
          migratedByUserId: null,
          migrationPausedRoutineIds: null,
          updatedAt: at,
        })
        .where(eq(companies.id, companyId));
      return {
        companyId,
        migratedToUrl: null,
        migratedAt: null,
        migratedByUserId: null,
        agentsResumed: resumedAgents.length,
        routinesResumed: resumedRoutines.length,
      };
    });
  }

  return { verifyDestination, markMigrated, undoMigrated };
}

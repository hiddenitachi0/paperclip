import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companySecretBindings, issueThreadInteractions, issues } from "@paperclipai/db";
import { LANE_A_API_KEY_CONFIG_PATH, type HelperDroppedReference, type PermissionKey } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor, type AuthorizationDecision } from "./authorization.js";

/**
 * "Ask Paperclip", Phase 3: the access checks around handing a question to
 * the investigation agent. The agent can read the whole company, so the
 * PERSON's own rights are checked before anything is handed over:
 *
 *   - may the person give work to that agent at all? The same "tasks:assign"
 *     decision the task routes make (assertCanAssignTasks): viewers, a
 *     private agent or one that needs an approval for new work are refused;
 *   - may the person see each record they marked (issue / agent / approval /
 *     thread interaction) and each picture they picked from Files (the task
 *     it is attached to)? Records they may not see are left out; a picture
 *     they may not see is refused.
 *
 * And the AGENT's: what could it change if text on screen talked it into it?
 * Its rights (grants) and the secrets it holds beyond its model login. An
 * owner/admin must confirm those before such an agent takes investigations.
 */

type IssueForRead = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rights that let an agent change things, with how the helper names them.
 * tasks:assign / tasks:assign_scope count only as an explicit grant: in
 * simple mode every active agent may hand tasks to others by default, which
 * is not something an agent "holds" (the task tells it not to).
 */
const WRITE_GRANTS: ReadonlyArray<{ keys: PermissionKey[]; label: string; explicitOnly?: boolean }> = [
  { keys: ["agents:create"], label: "can create agents and change their setup" },
  { keys: ["tasks:assign", "tasks:assign_scope"], label: "has the right to give tasks to other agents", explicitOnly: true },
  { keys: ["tasks:manage_active_checkouts"], label: "can take over tasks other agents are working on" },
  { keys: ["deploys:request"], label: "can ask for deploys" },
  { keys: ["merges:request"], label: "can ask for merges" },
  { keys: ["users:invite", "users:manage_permissions"], label: "can invite people or change their rights" },
  { keys: ["skills:create"], label: "can create skills" },
  { keys: ["environments:manage"], label: "can manage environments" },
  { keys: ["pipelines:write"], label: "can change pipelines" },
  { keys: ["joins:approve"], label: "can approve join requests" },
];

/** Env names that are only a model login (they let the agent think, not change things). */
const MODEL_LOGIN_ENV_RE =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|OPENROUTER_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|XAI_API_KEY|MISTRAL_API_KEY|DEEPSEEK_API_KEY|GROQ_API_KEY|CURSOR_API_KEY|OLLAMA_API_KEY)$/;

function secretNameOf(configPath: string): string {
  const env = /^env\.(.+)$/.exec(configPath);
  if (env) return env[1]!;
  const mcp = /^mcpServers\[([^\]]+)\]/.exec(configPath);
  if (mcp) return `${mcp[1]} tool`;
  return configPath;
}

export function helperAccessService(db: Db) {
  const authorization = authorizationService(db);

  async function decideIssueRead(actor: AuthorizationActor, issue: IssueForRead): Promise<AuthorizationDecision> {
    return authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
      scope: {
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
      },
    });
  }

  async function loadIssue(companyId: string, idOrIdentifier: string): Promise<IssueForRead | null> {
    const [row] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          UUID_RE.test(idOrIdentifier) ? eq(issues.id, idOrIdentifier) : eq(issues.identifier, idOrIdentifier.toUpperCase()),
        ),
      );
    return row ?? null;
  }

  /** May the person see the task this file is attached to (or, for a file with no task, the company's records)? */
  async function canReadAttachment(actor: AuthorizationActor, companyId: string, issueId: string | null): Promise<boolean> {
    if (!issueId) {
      return (await authorization.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } })).allowed;
    }
    const issue = await loadIssue(companyId, issueId);
    if (!issue) return false;
    return (await decideIssueRead(actor, issue)).allowed;
  }

  /**
   * Keeps the marked records the person may see. Anything else is left out
   * with a plain reason: not in this company, not visible to them, or a kind
   * of record Paperclip cannot check.
   */
  async function filterReferences(
    actor: AuthorizationActor,
    companyId: string,
    references: string[],
  ): Promise<{ kept: string[]; dropped: HelperDroppedReference[] }> {
    const kept: string[] = [];
    const dropped: HelperDroppedReference[] = [];
    const notHere = "it is not in this company";
    const hidden = "you do not have access to it";
    for (const reference of references) {
      const at = reference.indexOf(":");
      const kind = reference.slice(0, at);
      const id = reference.slice(at + 1);
      let reason: string | null = null;
      switch (kind) {
        case "issue": {
          const issue = await loadIssue(companyId, id);
          if (!issue) reason = notHere;
          else if (!(await decideIssueRead(actor, issue)).allowed) reason = hidden;
          break;
        }
        case "interaction": {
          const [row] = UUID_RE.test(id)
            ? await db
                .select({ issueId: issueThreadInteractions.issueId })
                .from(issueThreadInteractions)
                .where(and(eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, companyId)))
            : [];
          const issue = row ? await loadIssue(companyId, row.issueId) : null;
          if (!issue) reason = notHere;
          else if (!(await decideIssueRead(actor, issue)).allowed) reason = hidden;
          break;
        }
        case "agent": {
          const [row] = UUID_RE.test(id)
            ? await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, id), eq(agents.companyId, companyId)))
            : [];
          if (!row) reason = notHere;
          else if (!(await authorization.decide({ actor, action: "agent:read", resource: { type: "agent", companyId, agentId: id } })).allowed) {
            reason = hidden;
          }
          break;
        }
        case "approval": {
          const [row] = UUID_RE.test(id)
            ? await db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.id, id), eq(approvals.companyId, companyId)))
            : [];
          // Approval cards are read with the company's records (same check as GET /approvals/:id).
          if (!row) reason = notHere;
          else if (!(await authorization.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } })).allowed) {
            reason = hidden;
          }
          break;
        }
        default:
          reason = "Paperclip cannot check who may see this kind of record";
      }
      if (reason) dropped.push({ reference, reason });
      else kept.push(reference);
    }
    return { kept, dropped };
  }

  /** The same decision as assertCanAssignTasks for "give this agent a new task". */
  async function decideAssign(actor: AuthorizationActor, companyId: string, agentId: string): Promise<AuthorizationDecision> {
    const scope = { projectId: null, parentIssueId: null, assigneeAgentId: agentId, assigneeUserId: null };
    return authorization.decide({
      actor,
      action: "tasks:assign",
      resource: { type: "issue", companyId, issueId: null, ...scope },
      scope,
    });
  }

  /**
   * What the agent could change, in plain words: its rights (role, explicit
   * or legacy grants) and the secrets bound to it besides its model login.
   * Empty = nothing Paperclip knows of (its own tools are not counted).
   */
  async function writeCapabilities(companyId: string, agentId: string): Promise<string[]> {
    const actor: AuthorizationActor = { type: "agent", agentId, companyId, source: "agent_key" };
    const out: string[] = [];
    for (const right of WRITE_GRANTS) {
      let has = false;
      for (const key of right.keys) {
        const decision = right.explicitOnly
          ? await authorization.decidePrincipalGrant({
              companyId,
              principalType: "agent",
              principalId: agentId,
              action: key,
              permissionKey: key,
            })
          : await authorization.decide({ actor, action: key, resource: { type: "company", companyId } });
        if (decision.allowed) {
          has = true;
          break;
        }
      }
      if (has) out.push(right.label);
    }
    const bindings = await db
      .select({ configPath: companySecretBindings.configPath })
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, agentId),
        ),
      );
    const secrets = [
      ...new Set(
        bindings
          .map((b) => b.configPath)
          .filter((path) => path !== LANE_A_API_KEY_CONFIG_PATH)
          .map(secretNameOf)
          .filter((name) => !MODEL_LOGIN_ENV_RE.test(name)),
      ),
    ].sort();
    if (secrets.length > 0) out.push(`has secrets besides its model login (${secrets.join(", ")})`);
    return out;
  }

  return { canReadAttachment, filterReferences, decideAssign, writeCapabilities };
}

/** True when every current capability was in what the owner/admin confirmed for this agent. */
export function writeCapabilitiesAcknowledged(
  ack: { agentId: string; capabilities: string[] } | null | undefined,
  agentId: string,
  current: string[],
): boolean {
  if (current.length === 0) return true;
  if (!ack || ack.agentId !== agentId) return false;
  const seen = new Set(ack.capabilities);
  return current.every((c) => seen.has(c));
}

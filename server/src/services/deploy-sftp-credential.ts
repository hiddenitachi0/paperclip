// DUR-4068: the narrowly-scoped SFTP credential for a website project's
// production deploy target. Bound to exactly one agent (the project's
// deployPolicy.requestingAgentId — typically a Website Developer boss agent),
// never to a project, and never on a command line. Modelled on
// resolvePublishToken (server/src/services/persona-accounts.ts) and
// resolveGitHubToken (server/src/services/secrets.ts): a real
// company_secret_bindings row must already exist before anything can read a
// value back out — there is no name-convention fallback, and the value is
// never returned to that agent's own heartbeat, only to the instance-admin
// -only route the on-box deploy runner calls.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecretBindings } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

/** One credential per agent, so a typo in a caller-supplied path can never split it into two. */
export const DEPLOY_SFTP_CREDENTIAL_CONFIG_PATH = "credential";
export const DEPLOY_SFTP_CREDENTIAL_TARGET_TYPE = "deploy_sftp_credential" as const;

export interface DeploySftpCredential {
  /** "sftp_private_key" when the bound secret was saved with that kind, "sftp_password" otherwise. */
  kind: "sftp_password" | "sftp_private_key";
  value: string;
}

export function deploySftpCredentialService(db: Db) {
  const secrets = secretService(db);

  async function assertAgentInCompany(companyId: string, agentId: string) {
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!row) throw unprocessable("Agent does not belong to this company.");
  }

  async function deleteExistingBinding(companyId: string, agentId: string) {
    await db
      .delete(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, DEPLOY_SFTP_CREDENTIAL_TARGET_TYPE),
          eq(companySecretBindings.targetId, agentId),
          eq(companySecretBindings.configPath, DEPLOY_SFTP_CREDENTIAL_CONFIG_PATH),
        ),
      );
  }

  /**
   * Binds (or rebinds — e.g. rotating a password to a key, per HANDOFF.md's
   * open item on preferring an SSH key) the SFTP credential to one agent.
   * Board-only at the route layer.
   */
  async function bindCredential(companyId: string, agentId: string, secretId: string) {
    await assertAgentInCompany(companyId, agentId);
    await deleteExistingBinding(companyId, agentId);
    return secrets.createBinding({
      companyId,
      secretId,
      targetType: DEPLOY_SFTP_CREDENTIAL_TARGET_TYPE,
      targetId: agentId,
      configPath: DEPLOY_SFTP_CREDENTIAL_CONFIG_PATH,
    });
  }

  async function unbindCredential(companyId: string, agentId: string) {
    await deleteExistingBinding(companyId, agentId);
  }

  /**
   * Resolve the credential bound to one agent. Returns null when nothing is
   * bound yet (the deploy runner reports this as a plain "not configured"
   * failure rather than crashing).
   */
  async function resolveCredential(
    companyId: string,
    agentId: string,
    context: { actorType: "system" | "user"; actorId: string },
  ): Promise<DeploySftpCredential | null> {
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, DEPLOY_SFTP_CREDENTIAL_TARGET_TYPE),
          eq(companySecretBindings.targetId, agentId),
          eq(companySecretBindings.configPath, DEPLOY_SFTP_CREDENTIAL_CONFIG_PATH),
        ),
      );
    if (!binding) return null;
    const secret = await secrets.getById(binding.secretId);
    const value = await secrets.resolveSecretValue(companyId, binding.secretId, "latest", {
      consumerType: DEPLOY_SFTP_CREDENTIAL_TARGET_TYPE,
      consumerId: agentId,
      configPath: DEPLOY_SFTP_CREDENTIAL_CONFIG_PATH,
      actorType: context.actorType,
      actorId: context.actorId,
    });
    return { kind: secret?.kind === "sftp_private_key" ? "sftp_private_key" : "sftp_password", value };
  }

  return { bindCredential, unbindCredential, resolveCredential };
}

export type DeploySftpCredentialService = ReturnType<typeof deploySftpCredentialService>;

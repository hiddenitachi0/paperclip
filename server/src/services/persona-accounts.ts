// DUR-134: persona_accounts CRUD -- the operator-managed config for one
// platform channel a persona publishes to. Creation is board-only (mirrors
// personas.ts) because every safety-relevant column here is an explicit
// operator decision the 23 August ruling refuses to default silently:
// aiDisclosureEnabled, autonomyMode and dailyPostCap are all required by
// createPersonaAccountSchema before this service is ever called.
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecretBindings, personaAccounts, personas } from "@paperclipai/db";
import type {
  CreatePersonaAccountInput,
  UpdatePersonaAccountInput,
} from "@paperclipai/shared/validators/persona-account";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

// DUR-134: the persona_accounts secret binding always lives at this single
// configPath -- one credential per account, never a map of several. Kept as
// a constant (not a caller-supplied string) so a typo can't silently create
// an unreachable second binding.
export const PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH = "publish_token";

// "Pick a sensible fixed count (e.g. first 5 posts)" per the ticket -- no
// number was specified by the operator. Five gives a new persona enough
// posts for Filip to see the account settle into a consistent voice before
// autonomy kicks in, without turning warm-up into a second cap.
export const DEFAULT_WARMUP_POSTS_REQUIRED = 5;

export type PersonaAccountRow = typeof personaAccounts.$inferSelect;

export function personaAccountsService(db: Db) {
  const secrets = secretService(db);

  /**
   * Resolve the narrowly-scoped publish credential for one persona_accounts
   * row -- the only path to the raw secret value anywhere in this feature
   * (item 2). Modelled on resolveGitHubToken (server/src/services/secrets.ts):
   * unlike that name-convention lookup, this goes through a real
   * company_secret_bindings row (targetType:"persona_account") so an
   * operator must have explicitly bound a secret to this exact account
   * before anything can ever publish through it -- there is no fallback.
   */
  async function resolvePublishToken(
    companyId: string,
    accountId: string,
    context: { actorType: "system" | "user"; actorId: string },
  ): Promise<string> {
    const [binding] = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "persona_account"),
          eq(companySecretBindings.targetId, accountId),
          eq(companySecretBindings.configPath, PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH),
        ),
      );
    if (!binding) {
      throw unprocessable("No publish credential is bound to this persona account yet.", {
        code: "binding_missing",
      });
    }
    return secrets.resolveSecretValue(companyId, binding.secretId, "latest", {
      consumerType: "persona_account",
      consumerId: accountId,
      configPath: PERSONA_ACCOUNT_PUBLISH_TOKEN_CONFIG_PATH,
      actorType: context.actorType,
      actorId: context.actorId,
    });
  }

  async function assertPersonaInCompany(companyId: string, personaId: string) {
    const [persona] = await db
      .select({ id: personas.id })
      .from(personas)
      .where(and(eq(personas.id, personaId), eq(personas.companyId, companyId)));
    if (!persona) throw notFound("Persona not found");
  }

  async function createAccount(
    companyId: string,
    personaId: string,
    input: CreatePersonaAccountInput,
  ): Promise<PersonaAccountRow> {
    await assertPersonaInCompany(companyId, personaId);

    const [existing] = await db
      .select({ id: personaAccounts.id })
      .from(personaAccounts)
      .where(
        and(
          eq(personaAccounts.personaId, personaId),
          eq(personaAccounts.platform, input.platform),
          eq(personaAccounts.externalAccountId, input.externalAccountId),
        ),
      );
    if (existing) throw conflict("This persona is already connected to this account on this platform.");

    // Operators can only raise warm-up above the code default here, never
    // shorten it -- see createPersonaAccountSchema's comment. Clamping up
    // (not down) is enforced with Math.max rather than in the zod schema
    // because the schema has no way to reference the code default.
    const warmupPostsRequired = Math.max(
      input.warmupPostsRequired ?? DEFAULT_WARMUP_POSTS_REQUIRED,
      DEFAULT_WARMUP_POSTS_REQUIRED,
    );

    const [created] = await db
      .insert(personaAccounts)
      .values({
        companyId,
        personaId,
        platform: input.platform,
        accountLabel: input.accountLabel,
        externalAccountId: input.externalAccountId,
        aiDisclosureEnabled: input.aiDisclosureEnabled,
        autonomyMode: input.autonomyMode,
        dailyPostCap: input.dailyPostCap,
        warmupPostsRequired,
      })
      .returning();
    return created!;
  }

  async function getAccountById(accountId: string): Promise<PersonaAccountRow | null> {
    const [row] = await db.select().from(personaAccounts).where(eq(personaAccounts.id, accountId));
    return row ?? null;
  }

  async function listAccountsForPersona(personaId: string): Promise<PersonaAccountRow[]> {
    return db.select().from(personaAccounts).where(eq(personaAccounts.personaId, personaId));
  }

  async function listAccountsForCompany(companyId: string): Promise<PersonaAccountRow[]> {
    return db.select().from(personaAccounts).where(eq(personaAccounts.companyId, companyId));
  }

  async function updateAccount(
    accountId: string,
    input: UpdatePersonaAccountInput,
  ): Promise<PersonaAccountRow> {
    const existing = await getAccountById(accountId);
    if (!existing) throw notFound("Persona account not found");

    const [updated] = await db
      .update(personaAccounts)
      .set({
        accountLabel: input.accountLabel ?? existing.accountLabel,
        aiDisclosureEnabled: input.aiDisclosureEnabled ?? existing.aiDisclosureEnabled,
        autonomyMode: input.autonomyMode ?? existing.autonomyMode,
        dailyPostCap: input.dailyPostCap ?? existing.dailyPostCap,
        publishingPaused: input.publishingPaused ?? existing.publishingPaused,
        updatedAt: new Date(),
      })
      .where(eq(personaAccounts.id, accountId))
      .returning();
    return updated!;
  }

  async function deleteAccount(accountId: string): Promise<void> {
    const existing = await getAccountById(accountId);
    if (!existing) throw notFound("Persona account not found");
    await db.delete(personaAccounts).where(eq(personaAccounts.id, accountId));
  }

  return {
    createAccount,
    getAccountById,
    listAccountsForPersona,
    listAccountsForCompany,
    updateAccount,
    deleteAccount,
    resolvePublishToken,
  };
}

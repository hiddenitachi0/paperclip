import { randomUUID } from "node:crypto";
import type { createDb } from "@paperclipai/db";
import { companyHelperSettings, modelDirectoryEntries } from "@paperclipai/db";
import { HELPER_BINDING_TARGET_TYPE, helperKeyConfigPath } from "@paperclipai/shared";
import { secretService } from "../../services/secrets.ts";

/**
 * Storyline Phase 0: the AI director writes with the company's own model
 * (the helper's default saved model + the company's key). Tests that used
 * to set ANTHROPIC_API_KEY now give the company a saved Claude model and a
 * Claude key of its own; the Anthropic SDK mock still answers the call.
 */
export async function seedCompanyWriterModel(db: ReturnType<typeof createDb>, companyId: string, opts: { canSeePictures?: boolean } = {}) {
  const [entry] = await db
    .insert(modelDirectoryEntries)
    .values({
      companyId,
      name: `Writer ${randomUUID().slice(0, 6)}`,
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: null,
      ...(opts.canSeePictures !== undefined ? { specs: { vision: opts.canSeePictures } as never } : {}),
    })
    .returning();
  const secret = await secretService(db).create(companyId, { name: `Claude key ${randomUUID().slice(0, 6)}`, provider: "local_encrypted", value: `sk-ant-test-${randomUUID()}` });
  // Written directly (not through helper.ts): importing helper.ts here would
  // load the real Anthropic SDK before a test's vi.doMock replaces it.
  await secretService(db).syncSecretRefsForTarget(
    companyId,
    { targetType: HELPER_BINDING_TARGET_TYPE, targetId: companyId },
    [{ secretId: secret.id, configPath: helperKeyConfigPath("anthropic"), label: "Ask Paperclip helper (Claude)" }],
    { replaceAll: true },
  );
  await db.insert(companyHelperSettings).values({ companyId, defaultDirectoryEntryId: entry!.id, updatedByUserId: "test" });
  return { entryId: entry!.id, secretId: secret.id };
}

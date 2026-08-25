import { describe, expect, it } from "vitest";
import {
  createPluginSecretsHandler,
  PLUGIN_SECRET_REFS_DISABLED_MESSAGE,
} from "../services/plugin-secrets-handler.js";

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const SECRET_REF = "77777777-7777-4777-8777-777777777777";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

describe("createPluginSecretsHandler", () => {
  it("fails closed for plugin secret resolution until company scoping lands (no pluginKey given)", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: PLUGIN_ID,
    });

    await expect(
      handler.resolve({ secretRef: SECRET_REF }),
    ).rejects.toThrow(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
  });

  it("still rejects malformed secret refs before the feature-disable guard", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: PLUGIN_ID,
    });

    await expect(
      handler.resolve({ secretRef: "not-a-uuid" }),
    ).rejects.toThrow(/invalid secret reference/i);
  });

  it("stays fail-closed for a plugin not on the allowlist, even with a valid invocation scope", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: PLUGIN_ID,
      pluginKey: "some-other-plugin",
    });

    await expect(
      handler.resolve(
        { secretRef: SECRET_REF },
        { invocationScope: { companyId: COMPANY_ID } },
      ),
    ).rejects.toThrow(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
  });

  it("requires a verified invocation scope for the allow-listed plugin (no bare/ambient calls)", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: PLUGIN_ID,
      pluginKey: "paperclip.media-studio",
    });

    await expect(
      handler.resolve({ secretRef: SECRET_REF }),
    ).rejects.toThrow(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
  });

  it("rejects when the worker manager flags the invocation scope as invalid", async () => {
    const handler = createPluginSecretsHandler({
      db: {} as never,
      pluginId: PLUGIN_ID,
      pluginKey: "paperclip.media-studio",
    });

    await expect(
      handler.resolve({ secretRef: SECRET_REF }, { invalidInvocationScope: true }),
    ).rejects.toThrow(PLUGIN_SECRET_REFS_DISABLED_MESSAGE);
  });

  it("never leaks secret-service internals (not-found/wrong-company/etc) to the plugin worker", async () => {
    const handler = createPluginSecretsHandler({
      // Deliberately not a real Db — any lookup secretService attempts here
      // throws, which is exactly the case this test exercises: whatever the
      // underlying reason resolution failed, the plugin only ever sees the
      // same generic invalid-ref shape.
      db: {} as never,
      pluginId: PLUGIN_ID,
      pluginKey: "paperclip.media-studio",
    });

    await expect(
      handler.resolve(
        { secretRef: SECRET_REF },
        { invocationScope: { companyId: COMPANY_ID } },
      ),
    ).rejects.toThrow(/invalid secret reference/i);
  });
});

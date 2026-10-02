import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest from "../../../packages/plugins/media-studio/src/manifest.js";

/**
 * Filip, 2 Oct 2026: in the Edit tab every Sogni button (Remove background,
 * Upscale, Restore) failed with 'The ... (Sogni) tool does not take
 * "companyId"'. The host adds companyId to every action call, and the Sogni
 * tool schema refuses unknown fields. The action must drop it before checking.
 */
const COMPANY = "11111111-1111-4111-8111-111111111111";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

async function setup() {
  const harness = createTestHarness({ manifest, config: { provider: "mock" } });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("Media Studio edit.sogni action", () => {
  for (const [tool, extra] of [
    ["sogni-remove-background", {}],
    ["sogni-upscale-image", { scale: 2 }],
    ["sogni-restore-photo", { prompt: "clean up" }],
  ] as const) {
    it(`${tool}: the host's companyId does not trip the tool's field check`, async () => {
      const harness = await setup();
      const run = harness.performAction(
        "edit.sogni",
        { tool, imageDataUrl: PNG, ...extra },
        { companyId: COMPANY, actor: { type: "user", userId: "user-1" } },
      );
      // With no Sogni key configured it stops at the key check, i.e. AFTER the
      // argument check passed. Before the fix it failed on "companyId".
      await expect(run).rejects.toThrow(/Sogni API key/);
      await expect(run).rejects.not.toThrow(/does not take/);
    });
  }

  it("still refuses a genuinely unknown field", async () => {
    const harness = await setup();
    await expect(
      harness.performAction(
        "edit.sogni",
        { tool: "sogni-upscale-image", imageDataUrl: PNG, colour: "red" },
        { companyId: COMPANY, actor: { type: "user", userId: "user-1" } },
      ),
    ).rejects.toThrow(/does not take "colour"/);
  });
});

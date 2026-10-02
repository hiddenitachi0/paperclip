import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin, { prepareGeneration } from "../../../packages/plugins/media-studio/src/worker.js";
import manifest from "../../../packages/plugins/media-studio/src/manifest.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const MAJA = "33333333-3333-4333-8333-333333333333";
const ISSUE = "66666666-6666-4666-8666-666666666666";
const FAL_MODEL = "fal-ai/flux/schnell";

const night = { id: "look-night", name: "Maja Night", style: "night style", provider: "sogni", model: "z-turbo", seed: null, referenceFileIds: [], updatedAt: "2026-09-28T00:00:00.000Z" };

async function setup() {
  const harness = createTestHarness({ manifest, config: { provider: "sogni", sogniKeySecretRef: "sogni-key-ref" } });
  harness.seed({ issues: [{ id: ISSUE, companyId: COMPANY, title: "Make a banner", description: `Use ${FAL_MODEL} for it.` }] } as never);
  await plugin.definition.setup(harness.ctx);
  await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "looks" }, [night]);
  await harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY, stateKey: "lookDefaults" }, { [MAJA]: night.id });
  return harness;
}

describe("a call model only counts when a person named it", () => {
  it("ignores an unrequested Fal model and keeps the Sogni look, with a note", async () => {
    const h = await setup();
    const r: any = await prepareGeneration(h.ctx, COMPANY, { prompt: "a cat", model: FAL_MODEL }, { agentId: MAJA, requesterMessage: "draw a cat" });
    expect(r.error).toBeUndefined();
    expect(r.input.provider).toBe("sogni");
    expect(r.input.model).not.toBe(FAL_MODEL);
    expect(r.notes.join(" ")).toContain("nobody asked for it by name");
  });

  it("honours a Fal model the person named in their own message", async () => {
    const h = await setup();
    const r: any = await prepareGeneration(h.ctx, COMPANY, { prompt: "a cat", model: FAL_MODEL }, { agentId: MAJA, requesterMessage: `use ${FAL_MODEL} please` });
    expect(r.input.provider).toBe("fal");
    expect(r.input.model).toBe(FAL_MODEL);
  });

  it("honours a Fal model named in the attached issue (full agent)", async () => {
    const h = await setup();
    const r: any = await prepareGeneration(h.ctx, COMPANY, { prompt: "a cat", model: FAL_MODEL, issueId: ISSUE }, { agentId: MAJA });
    expect(r.input.provider).toBe("fal");
  });

  it("falls back to the default look for an unknown look name, with a note", async () => {
    const h = await setup();
    const r: any = await prepareGeneration(h.ctx, COMPANY, { prompt: "a cat", look: "Nope" }, { agentId: MAJA });
    expect(r.error).toBeUndefined();
    expect(r.look.name).toBe("Maja Night");
    expect(r.notes.join(" ")).toContain('no saved look called "Nope"');
  });
});

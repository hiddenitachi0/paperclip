import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, { TOOL_GENERATE, TOOL_LIST_LOOKS } from "../../../packages/plugins/media-studio/src/manifest.js";
import { FAL_REFERENCE_MODEL } from "../../../packages/plugins/media-studio/src/providers.js";

/**
 * Media Studio's "Generate image" tool: pictures without a task (saved as a
 * company file), consistency (seed, reference pictures, saved looks), and the
 * rules that must not move: the daily limit, the task path, and company
 * boundaries for references.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const ISSUE = "55555555-5555-4555-8555-555555555555";
const REF_A = "66666666-6666-4666-8666-666666666666";
const REF_B = "77777777-7777-4777-8777-777777777777";
const FOREIGN_REF = "88888888-8888-4888-8888-888888888888";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const runCtx = { agentId: AGENT, runId: RUN, companyId: COMPANY, projectId: "" };

function companyFile(id: string, companyId: string, contentType = "image/png") {
  const contentPath = `/api/attachments/${id}/content`;
  return {
    id,
    companyId,
    issueId: null,
    contentType,
    byteSize: 4,
    originalFilename: `${id.slice(0, 4)}.png`,
    createdByAgentId: null,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    createdAt: new Date(),
    contentBase64: Buffer.from(`bytes-of-${id.slice(0, 4)}`).toString("base64"),
  };
}

async function setup(config: Record<string, unknown> = { provider: "mock" }): Promise<TestHarness> {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companyFiles: [
      companyFile(REF_A, COMPANY),
      companyFile(REF_B, COMPANY),
      companyFile(FOREIGN_REF, OTHER_COMPANY),
    ],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

/** A fake Fal: records each request, answers with one picture and the seed it "used". */
function fakeFal(harness: TestHarness, reportedSeed = 987) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://fal.run/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(
        JSON.stringify({
          images: [{ url: "https://v3.fal.media/files/out.jpg", content_type: "image/jpeg" }],
          seed: typeof body.seed === "number" ? body.seed : reportedSeed,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    calls.push({ url, body: null });
    // The picture itself, fetched from Fal's CDN.
    return new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
  }) as typeof harness.ctx.http.fetch;
  return calls;
}

const FAL_CONFIG = { provider: "fal", falKeySecretRef: "fal-key-ref" };

describe("media-studio generate-image without a task", () => {
  let harness: TestHarness;
  beforeEach(async () => {
    harness = await setup();
  });

  it("saves the picture as a company file in the verified company, with the run, and reports the seed", async () => {
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");
    const attach = vi.spyOn(harness.ctx.issues, "createAttachment");
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");

    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a green sofa", seed: 31337 }, runCtx);

    expect(result.error).toBeUndefined();
    expect(reserve).toHaveBeenCalledWith(COMPANY, { runId: RUN });
    expect(attach).not.toHaveBeenCalled();
    expect(createFile).toHaveBeenCalledTimes(1);
    const [input, companyId, options] = createFile.mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(options).toEqual({ runId: RUN });
    expect(input.contentType).toBe("image/svg+xml");
    expect(input.filename).toBe("image-seed-31337.svg");
    expect(result.data).toMatchObject({
      fileId: expect.any(String),
      contentPath: expect.stringMatching(/^\/api\/attachments\/[0-9a-f-]+\/content$/),
      contentType: "image/svg+xml",
      seed: 31337,
      issueId: null,
    });
    expect(result.content).toContain("saved it to the company's Files (not tied to a task)");
    expect(result.content).toContain("Seed: 31337");
    // The seed is kept next to the file, per company.
    expect(
      harness.getState({ scopeKind: "company", scopeId: COMPANY, stateKey: `image:${result.data.fileId}` }),
    ).toMatchObject({ seed: 31337, prompt: "a green sofa" });
  });

  it("still enforces the agent's daily picture limit, before anything is generated or saved", async () => {
    vi.spyOn(harness.ctx.personas, "reserveDailyGeneration").mockResolvedValue({ allowed: false, cap: 3, usedToday: 3 });
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");
    const calls = fakeFal(harness);
    harness.setConfig(FAL_CONFIG);

    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa" }, runCtx);

    expect(result.error).toBe("Daily image limit (3) reached for this agent today.");
    expect(createFile).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing prompt and a bad seed without using up the day's limit", async () => {
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    expect((await harness.executeTool<any>(TOOL_GENERATE, { prompt: " " }, runCtx)).error).toBe("prompt is required");
    expect((await harness.executeTool<any>(TOOL_GENERATE, { prompt: "x", seed: -4 }, runCtx)).error).toMatch(/whole number/);
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe("media-studio generate-image with a task (unchanged)", () => {
  it("attaches to the given task with the run and author, and saves no company file", async () => {
    const harness = await setup();
    const attach = vi.spyOn(harness.ctx.issues, "createAttachment").mockResolvedValue({
      id: REF_A,
      contentPath: `/api/attachments/${REF_A}/content`,
    } as any);
    const createFile = vi.spyOn(harness.ctx.files, "createCompanyFile");

    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", issueId: ISSUE }, runCtx);

    expect(result.error).toBeUndefined();
    expect(createFile).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith(
      ISSUE,
      expect.objectContaining({ contentType: "image/svg+xml", filename: "mock-generation.svg+xml" }),
      COMPANY,
      { authorAgentId: AGENT, runId: RUN },
    );
    expect(result.content).toContain("attached it to the issue");
    expect(result.data).toMatchObject({ attachmentId: REF_A, contentPath: `/api/attachments/${REF_A}/content`, fileId: REF_A, issueId: ISSUE });
  });

  it("passes on the host's refusal for a task it may not attach to", async () => {
    const harness = await setup();
    vi.spyOn(harness.ctx.issues, "createAttachment").mockRejectedValue(
      new Error("The task T-1 was not named in the message, so the quick agent cannot attach to it."),
    );
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", issueId: ISSUE }, runCtx);
    expect(result.error).toContain("was not named in the message");
  });
});

describe("media-studio consistency: seed and reference pictures", () => {
  it("passes the seed to Fal and reports the seed Fal used", async () => {
    const harness = await setup(FAL_CONFIG);
    const calls = fakeFal(harness);

    const withSeed = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", seed: 123 }, runCtx);
    expect(calls[0]?.url).toBe("https://fal.run/fal-ai/flux/schnell");
    expect(calls[0]?.body?.seed).toBe(123);
    expect(withSeed.data.seed).toBe(123);

    const withoutSeed = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa" }, runCtx);
    const falCalls = calls.filter((call) => call.body);
    expect(falCalls[1]?.body).not.toHaveProperty("seed");
    expect(withoutSeed.data.seed).toBe(987);
    expect(withoutSeed.content).toContain("Seed: 987");
  });

  it("accepts a seed the model sent as text", async () => {
    const harness = await setup(FAL_CONFIG);
    const calls = fakeFal(harness);
    await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", seed: "4242" }, runCtx);
    expect(calls[0]?.body?.seed).toBe(4242);
  });

  it("sends same-company reference pictures to the reference model as data URIs, never as Paperclip addresses", async () => {
    const harness = await setup(FAL_CONFIG);
    const calls = fakeFal(harness);

    const result = await harness.executeTool<any>(
      TOOL_GENERATE,
      { prompt: "the same chair in a garden", referenceFileIds: [REF_A, REF_B] },
      runCtx,
    );

    expect(result.error).toBeUndefined();
    expect(calls[0]?.url).toBe(`https://fal.run/${FAL_REFERENCE_MODEL}`);
    const imageUrls = calls[0]?.body?.image_urls as string[];
    expect(imageUrls).toHaveLength(2);
    expect(imageUrls[0]).toBe(`data:image/png;base64,${Buffer.from("bytes-of-6666").toString("base64")}`);
    expect(JSON.stringify(calls[0]?.body)).not.toContain("/api/attachments");
  });

  it("refuses a reference picture from another company, before spending anything", async () => {
    const harness = await setup(FAL_CONFIG);
    const calls = fakeFal(harness);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const read = vi.spyOn(harness.ctx.files, "readContent");

    const result = await harness.executeTool<any>(
      TOOL_GENERATE,
      { prompt: "the same chair", referenceFileIds: [REF_A, FOREIGN_REF] },
      runCtx,
    );

    expect(result.error).toBe(
      `The reference picture ${FOREIGN_REF} is not in this company's Files, so it cannot be used. Pick a picture from this company's Files.`,
    );
    expect(read).not.toHaveBeenCalledWith(FOREIGN_REF, expect.anything());
    expect(reserve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses more than four reference pictures", async () => {
    const harness = await setup(FAL_CONFIG);
    const ids = [REF_A, REF_B, "a1111111-1111-4111-8111-111111111111", "a2222222-2222-4222-8222-222222222222", "a3333333-3333-4333-8333-333333333333"];
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "x", referenceFileIds: ids }, runCtx);
    expect(result.error).toMatch(/At most 4 reference pictures/);
  });
});

describe("media-studio saved looks", () => {
  const looksKey = { scopeKind: "company" as const, scopeId: COMPANY, stateKey: "looks" };
  const catalogue = {
    id: "look-1",
    name: "Catalogue",
    style: "soft daylight, light oak, linen",
    model: "fal-ai/flux-pro/kontext/max/multi",
    seed: 777,
    referenceFileIds: [REF_A],
    updatedAt: "2026-09-27T00:00:00.000Z",
  };

  it("applies a look's style words, model, fixed seed and reference pictures", async () => {
    const harness = await setup(FAL_CONFIG);
    await harness.ctx.state.set(looksKey, [catalogue]);
    const calls = fakeFal(harness);

    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", look: "catalogue" }, runCtx);

    expect(result.error).toBeUndefined();
    expect(calls[0]?.url).toBe("https://fal.run/fal-ai/flux-pro/kontext/max/multi");
    expect(calls[0]?.body?.prompt).toBe("a sofa\n\nStyle: soft daylight, light oak, linen");
    expect(calls[0]?.body?.seed).toBe(777);
    expect(calls[0]?.body?.image_urls).toEqual([`data:image/png;base64,${Buffer.from("bytes-of-6666").toString("base64")}`]);
    expect(result.data).toMatchObject({ look: "Catalogue", seed: 777 });
    expect(result.content).toContain('Used the saved look "Catalogue"');
  });

  it("sends nothing for a look's Sogni LoRAs to Fal.ai, and says they were not used", async () => {
    const harness = await setup(FAL_CONFIG);
    await harness.ctx.state.set(looksKey, [{ ...catalogue, provider: "fal", loras: [{ id: "krea2-candid", name: "Editorial <-> Candid", strength: 3 }] }]);
    const calls = fakeFal(harness);
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", look: "Catalogue" }, runCtx);
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(calls[0]?.body)).not.toContain("krea2-candid");
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/lora/i);
    expect(result.content).toContain("The look's LoRAs were not used: they are Sogni LoRAs, and this picture was made with Fal.ai.");
  });

  it("lets an explicit seed win over the look's fixed seed, and adds the person's references to the look's", async () => {
    const harness = await setup(FAL_CONFIG);
    await harness.ctx.state.set(looksKey, [catalogue]);
    const calls = fakeFal(harness);
    await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", look: "Catalogue", seed: 5, referenceFileIds: [REF_B] }, runCtx);
    expect(calls[0]?.body?.seed).toBe(5);
    expect((calls[0]?.body?.image_urls as string[]).length).toBe(2);
  });

  it("names the saved looks when an unknown one is asked for, and uses nothing up", async () => {
    const harness = await setup();
    await harness.ctx.state.set(looksKey, [catalogue]);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", look: "Summer" }, runCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('There is no saved look called "Summer", so no look was used');
    expect(result.content).toContain("Saved looks: Catalogue.");
  });

  it("never reads another company's looks", async () => {
    const harness = await setup();
    await harness.ctx.state.set({ ...looksKey, scopeId: OTHER_COMPANY }, [catalogue]);
    const result = await harness.executeTool<any>(TOOL_GENERATE, { prompt: "a sofa", look: "Catalogue" }, runCtx);
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('There is no saved look called "Catalogue"');
  });

  it("lists the looks for the quick agent (read only)", async () => {
    const harness = await setup();
    expect((await harness.executeTool<any>(TOOL_LIST_LOOKS, {}, runCtx)).content).toMatch(/No looks are saved yet/);
    await harness.ctx.state.set(looksKey, [catalogue]);
    const listed = await harness.executeTool<any>(TOOL_LIST_LOOKS, {}, runCtx);
    expect(listed.content).toContain("- Catalogue: soft daylight, light oak, linen (fixed seed 777; 1 reference picture;");
  });

  it("lets only a company owner/admin save or delete looks, and checks references are this company's pictures", async () => {
    const harness = await setup();
    const owner = { actor: { type: "user" as const, userId: "u1", canManageCompany: true }, companyId: COMPANY };
    const member = { actor: { type: "user" as const, userId: "u2", canManageCompany: false }, companyId: COMPANY };
    const agent = { actor: { type: "agent" as const, agentId: AGENT }, companyId: COMPANY };
    const draft = { name: "Catalogue", style: "linen", model: "", seed: "12", referenceFileIds: [REF_A] };

    await expect(harness.performAction("looks.save", draft, member)).rejects.toThrow(
      "Only the company's owner or an admin can change looks.",
    );
    await expect(harness.performAction("looks.save", draft, agent)).rejects.toThrow("Only the company's owner or an admin");
    await expect(
      harness.performAction("looks.save", { ...draft, referenceFileIds: [FOREIGN_REF] }, owner),
    ).rejects.toThrow("One of the reference pictures is not in this company's Files.");

    const saved = await harness.performAction<any>("looks.save", draft, owner);
    expect(saved.looks).toHaveLength(1);
    expect(saved.looks[0]).toMatchObject({ name: "Catalogue", style: "linen", model: null, seed: 12, referenceFileIds: [REF_A] });
    expect(harness.getState(looksKey)).toHaveLength(1);

    await expect(harness.performAction("looks.save", { ...draft, style: "other" }, owner)).rejects.toThrow(
      'There is already a look called "Catalogue".',
    );

    const listedByMember = await harness.performAction<any>("looks.list", {}, member);
    expect(listedByMember).toMatchObject({ canManage: false, looks: [expect.objectContaining({ name: "Catalogue" })] });
    expect((await harness.performAction<any>("looks.list", {}, owner)).canManage).toBe(true);

    await expect(harness.performAction("looks.delete", { id: saved.looks[0].id }, member)).rejects.toThrow("Only the company's owner");
    const afterDelete = await harness.performAction<any>("looks.delete", { id: saved.looks[0].id }, owner);
    expect(afterDelete.looks).toEqual([]);
  });

  it("gates the Settings tab on instance-admin, not company owner/admin -- saving it goes through the instance-admin-only generic plugin-config route (DUR-4363)", async () => {
    const harness = await setup();
    const owner = { actor: { type: "user" as const, userId: "u1", canManageCompany: true, isInstanceAdmin: false }, companyId: COMPANY };
    const instanceAdmin = { actor: { type: "user" as const, userId: "u2", canManageCompany: false, isInstanceAdmin: true }, companyId: COMPANY };
    const member = { actor: { type: "user" as const, userId: "u3", canManageCompany: false, isInstanceAdmin: false }, companyId: COMPANY };

    expect((await harness.performAction<any>("settings.access", {}, owner)).canManage).toBe(false);
    expect((await harness.performAction<any>("settings.access", {}, member)).canManage).toBe(false);
    expect((await harness.performAction<any>("settings.access", {}, instanceAdmin)).canManage).toBe(true);
  });
});

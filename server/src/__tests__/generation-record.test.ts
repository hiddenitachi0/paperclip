import { describe, expect, it } from "vitest";
import { buildGenerationRecord, explainDroppedLoras, scrubRecordText } from "../services/generation-record.ts";
import { safetyFieldsOf } from "../services/generation-facts.ts";
import { sniffImageType, storedImageType } from "../services/image-type.ts";
import { FalImageProvider } from "../services/image-provider-clients.ts";
import { sanitizeRecord } from "../redaction.ts";

const KEY = "sk-FAKEKEYFORTESTS1234567890abcdef";

describe("scrubRecordText", () => {
  it("removes picture data, key-shaped text and the request's own key", () => {
    const text = scrubRecordText(`a face data:image/png;base64,iVBORw0KGgo= with ${KEY} and my-own-secret-value`, ["my-own-secret-value"]);
    expect(text).not.toContain("base64");
    expect(text).not.toContain("FAKEKEY");
    expect(text).not.toContain("my-own-secret-value");
    expect(text).toContain("a face");
  });
});

describe("buildGenerationRecord", () => {
  it("carries every field and survives the activity log's own redaction unchanged", () => {
    const record = buildGenerationRecord({
      kind: "still",
      prompt: "A harbour",
      provider: "sogni",
      model: "z-turbo",
      sent: { tool: "generate_image", safety: { safe_content_filter: true }, contentFilterOn: true, promptExpansion: "not supported by this tool", seed: 5, negativePrompt: "blurry" },
      loras: [{ id: "a", strength: 0.5 }],
      lorasDropped: [{ id: "b", reason: "flagged" }],
      contentRating: "sfw",
      references: [{ fileId: "f1", role: "face" }],
      estimatedCostCents: 2,
      actualCostCents: 2,
      now: new Date("2026-10-27T10:00:00Z"),
    });
    expect(record).toMatchObject({ seed: 5, negativePromptSent: "blurry", tool: "generate_image", referencesNotSent: 0, providerCredits: null, notes: [], editModel: null });
    // logActivity runs sanitizeRecord over details: no field name of the record may look like a secret.
    expect(sanitizeRecord({ generation: record })).toEqual({ generation: record });
  });

  it("says the seed is not supported when the tool reported nothing", () => {
    const record = buildGenerationRecord({ kind: "clip", prompt: "x", provider: "fal", model: null, sent: null, contentRating: "mature", estimatedCostCents: null });
    expect(record.seed).toBe("not supported by this tool");
    expect(record.contentRating).toBe("mature");
  });
});

describe("explainDroppedLoras", () => {
  const info = (id: string, modelIds: string[], over: Record<string, unknown> = {}) => ({
    id, name: id, description: "", category: null, personal: false, modelIds, min: 0, max: 1, default: 0.8, step: 0.05, recommendedMin: 0.5, recommendedMax: 1, rangeLabels: null, needsFilterOff: false, sexual: false, creator: null, sourceUrl: null, ...over,
  });
  it("gives a reason for each LoRA that did not go out, and none for those that did", () => {
    const known = [info("fits", ["z_image_turbo_bf16"]), info("other", ["qwen_image_edit_2511_fp8_lightning"]), info("spicy", ["z_image_turbo_bf16"], { sexual: true })];
    const requested = ["fits", "other", "spicy", "gone"].map((id) => ({ id, strength: 0.5 }));
    const dropped = explainDroppedLoras({ requested, sent: [{ id: "fits", strength: 0.5 }], mode: "sfw", model: "z-turbo", known });
    expect(dropped.map((d) => d.id).sort()).toEqual(["gone", "other", "spicy"]);
    expect(dropped.every((d) => d.reason.length > 10)).toBe(true);
    expect(dropped.find((d) => d.id === "spicy")!.reason).toMatch(/mature|sexual|safe/i);
    // In a mature film only the model fit and Sogni's limit can leave a LoRA out.
    const mature = explainDroppedLoras({ requested, sent: [{ id: "fits", strength: 0.5 }], mode: "mature", model: "z-turbo", known });
    expect(mature.find((d) => d.id === "other")!.reason).toMatch(/Made for/);
    expect(mature.find((d) => d.id === "gone")!.reason).toMatch(/does not list/);
  });
  it("is empty when nothing was left out", () => {
    expect(explainDroppedLoras({ requested: [{ id: "a", strength: 1 }], sent: [{ id: "a", strength: 1 }], mode: "sfw", model: "z-turbo", known: null })).toEqual([]);
  });
});

describe("image type", () => {
  it("goes by the bytes, not the header", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
    expect(sniffImageType(png)).toBe("image/png");
    expect(storedImageType(png, "image/jpeg")).toEqual({ contentType: "image/png", extension: "png" });
    expect(storedImageType(jpg, "image/png; charset=binary")).toEqual({ contentType: "image/jpeg", extension: "jpg" });
    expect(storedImageType(Buffer.from("junk"), "Image/WEBP")).toEqual({ contentType: "image/webp", extension: "webp" });
  });
});

describe("provider facts are read from the request body", () => {
  it("picks safety fields by name", () => {
    expect(safetyFieldsOf({ prompt: "x", enable_safety_checker: true, safety_tolerance: "2", num_images: 1, safe_content_filter: false })).toEqual({
      enable_safety_checker: true,
      safety_tolerance: "2",
      safe_content_filter: false,
    });
  });
  it("Fal's picture client reports what it sent, never its key", async () => {
    let sentBody: Record<string, unknown> = {};
    const provider = new FalImageProvider(KEY, async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ images: [{ url: "https://v3.fal.media/x.png", content_type: "image/png", width: 1024, height: 576 }] }), { status: 200 });
    });
    const withPictures = await provider.generate({ prompt: "p", referenceImages: ["data:image/png;base64,AAAA"] });
    expect(sentBody.safety_tolerance).toBe("2");
    expect(withPictures.sent).toMatchObject({ tool: null, safety: { safety_tolerance: "2" }, seed: "not supported by this tool", promptExpansion: "not supported by this tool" });
    const plain = await provider.generate({ prompt: "p" });
    expect(plain.sent?.safety).toEqual({ enable_safety_checker: true });
    expect(JSON.stringify([withPictures, plain])).not.toContain("FAKEKEY");
    expect(JSON.stringify([withPictures, plain])).not.toContain("base64");
  });
});

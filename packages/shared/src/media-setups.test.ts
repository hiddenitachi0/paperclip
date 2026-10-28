import { describe, expect, it } from "vitest";
import {
  MEDIA_STARTER_SETUPS,
  checkMediaLoraFields as checkLoraFieldsWith,
  checkMediaSetup as checkSetupWith,
  createMediaLoraSchema,
  createMediaSetupSchema,
  createMediaSetupTrialSchema,
  effectiveMediaLoraContentTag,
  mediaLoraLinkSecretParams,
  mediaLoraRefForAgents,
  mediaModelCapability,
  mediaSetupParamProblems,
  pickMediaSetupParams,
  summarizeMediaSetupTrials,
  updateMediaSetupSchema,
  type MediaContentRules,
  type MediaLoraForCheck,
  type MediaSetupForCheck,
} from "./media-setups.js";

// The real content rules are the Media Studio safety module's, which this
// package cannot import; the server passes them in, and
// server/src/__tests__/media-content-rules.test.ts checks setups and LoRAs
// against them (krea2-age, filter bypass in any spelling, nsfw models, the
// starters). These stand-ins only test how a check uses a rule's answer.
const rules: MediaContentRules = {
  loraFloor: (lora) =>
    lora.ref === "test-never"
      ? { tag: "refused", reason: `The LoRA "${lora.name ?? lora.ref}" is never allowed.` }
      : lora.ref === "test-mature" || lora.providerNsfw
        ? { tag: "mature", reason: `The LoRA "${lora.name ?? lora.ref}" is mature by the rules.` }
        : null,
  modelMatureReason: (modelId) => (modelId.includes("spicy") ? `The model "${modelId}" is made for mature pictures.` : null),
};
const checkMediaSetup = (setup: MediaSetupForCheck, library: ReadonlyMap<string, MediaLoraForCheck>) => checkSetupWith(setup, library, rules);
const checkMediaLoraFields = (lora: Parameters<typeof checkLoraFieldsWith>[0]) => checkLoraFieldsWith(lora, rules);

function lora(overrides: Partial<MediaLoraForCheck> = {}): MediaLoraForCheck {
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    provider: "sogni",
    source: "catalog",
    ref: "h3-better-motion",
    name: "Better Motion",
    family: "h3",
    compatibleModelIds: ["minimax-h3-fl2va-fp8_flf2v", "minimax-h3-fl2va-fp8_i2v"],
    contentTag: "sfw",
    providerNsfw: false,
    providerSexual: false,
    strengthMin: 0,
    strengthMax: 1.5,
    triggerWords: [],
    archivedAt: null,
    ...overrides,
  };
}

function setup(overrides: Partial<MediaSetupForCheck> = {}): MediaSetupForCheck {
  return {
    kind: "video",
    provider: "sogni",
    modelId: "minimax-h3-fl2va-fp8_flf2v",
    mode: null,
    editModelId: null,
    loras: [],
    params: { promptExpansion: false },
    ...overrides,
  };
}

function library(...rows: MediaLoraForCheck[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

describe("media setups: capability table", () => {
  it("knows H3 takes LoRAs and reads the mode from the exact id", () => {
    const cap = mediaModelCapability("sogni", "minimax-h3-fl2va-fp8_flf2v");
    expect(cap).toMatchObject({ family: "h3", takesLoras: true, mode: "flf2v", kinds: ["video"], billing: "sogni-unlimited" });
    expect(mediaModelCapability("sogni", "minimax-h3-ref2va-fp8_r2v").mode).toBe("r2v");
  });

  it("says Wan 3 takes no LoRA on Sogni or Fal", () => {
    for (const [provider, id] of [
      ["sogni", "wan3.0-video"],
      ["fal", "alibaba/wan-3.0/image-to-video"],
    ] as const) {
      const cap = mediaModelCapability(provider, id);
      expect(cap.family).toBe("wan3");
      expect(cap.takesLoras).toBe(false);
      expect(cap.noLoraReason).toMatch(/Wan 3 takes no LoRA/);
    }
    expect(mediaModelCapability("sogni", "wan3.0-video").billing).toBe("sogni-premium");
  });

  it("knows which Fal endpoints take LoRA links", () => {
    expect(mediaModelCapability("fal", "fal-ai/wan-flf2v")).toMatchObject({ takesLoras: true, family: "wan21", mode: "flf2v", kinds: ["video"] });
    expect(mediaModelCapability("fal", "minimax/h3/text-to-video/lora")).toMatchObject({ takesLoras: true, family: "h3", mode: "t2v" });
    expect(mediaModelCapability("fal", "fal-ai/flux-lora")).toMatchObject({ takesLoras: true, kinds: ["image"] });
    expect(mediaModelCapability("fal", "minimax/h3-max/image-to-video").takesLoras).toBe(false);
    expect(mediaModelCapability("fal", "fal-ai/kling-video/v4/image-to-video").takesLoras).toBe(false);
  });

  it("keeps no content rules of its own", () => {
    // Whether a model is mature is the safety module's call (MediaContentRules).
    expect(mediaModelCapability("sogni", "ltx23-eros")).toMatchObject({ family: "ltx", takesLoras: false });
    expect(Object.keys(mediaModelCapability("sogni", "wan3.0-spicy-video"))).not.toContain("matureTags");
  });
});

describe("media setups: checking a setup", () => {
  it("accepts H3 with Better Motion at 0.6, as safe for work", () => {
    const result = checkMediaSetup(setup({ loras: [{ loraId: lora().id, strength: 0.6 }] }), library(lora({ triggerWords: ["smooth"] })));
    expect(result.problems).toEqual([]);
    expect(result.contentRating).toBe("sfw");
    expect(result.mode).toBe("flf2v");
    expect(result.triggerWords).toEqual(["smooth"]);
  });

  it("refuses any LoRA on Wan 3", () => {
    const result = checkMediaSetup(setup({ modelId: "wan3.0-video", loras: [{ loraId: lora().id, strength: 0.6 }] }), library(lora()));
    expect(result.problems.join(" ")).toMatch(/Wan 3 takes no LoRA/);
  });

  it("refuses strengths outside the LoRA's range, such as a percentage", () => {
    const result = checkMediaSetup(setup({ loras: [{ loraId: lora().id, strength: 35 }] }), library(lora()));
    expect(result.problems.join(" ")).toMatch(/at most 1\.5 \(it is 35\).*multipliers, not percentages/);
    const negative = checkMediaSetup(setup({ loras: [{ loraId: lora().id, strength: -0.1 }] }), library(lora()));
    expect(negative.problems).toHaveLength(1);
  });

  it("keeps an imported Sogni LoRA above 0 and at most 1", () => {
    const personal = lora({ source: "personal", ref: "personal-maja", name: "Maja", strengthMin: null, strengthMax: null, compatibleModelIds: [] });
    expect(checkMediaSetup(setup({ loras: [{ loraId: personal.id, strength: 0 }] }), library(personal)).problems).toHaveLength(1);
    expect(checkMediaSetup(setup({ loras: [{ loraId: personal.id, strength: 1 }] }), library(personal)).problems).toEqual([]);
  });

  it("refuses a LoRA the exact model id does not take", () => {
    const vhs = lora({ ref: "h3-vh5tape-vhs", name: "vh5tape", compatibleModelIds: ["minimax-h3-fl2va-fp8_flf2v"] });
    const result = checkMediaSetup(setup({ modelId: "minimax-h3-fl2va-fp8_t2v", loras: [{ loraId: vhs.id, strength: 1 }] }), library(vhs));
    expect(result.problems.join(" ")).toMatch(/does not work with the model "minimax-h3-fl2va-fp8_t2v"/);
  });

  it("matches a catalog LoRA saved without a family by its Sogni id", () => {
    const krea = lora({ ref: "krea2-detail-enhancer", name: "Detail", family: null, compatibleModelIds: [] });
    expect(checkMediaSetup(setup({ loras: [{ loraId: krea.id, strength: 0.6 }] }), library(krea)).problems.join(" ")).toMatch(/does not work with the model/);
    expect(
      checkMediaSetup(setup({ kind: "image", modelId: "krea2_turbo_fp8_scaled", loras: [{ loraId: krea.id, strength: 0.6 }] }), library(krea)).problems,
    ).toEqual([]);
  });

  it("refuses a LoRA from another service, a missing or archived one, and duplicates", () => {
    const falLora = lora({ provider: "fal", source: "url", ref: "https://huggingface.co/x/y.safetensors", name: "Fal one" });
    expect(checkMediaSetup(setup({ loras: [{ loraId: falLora.id, strength: 0.6 }] }), library(falLora)).problems.join(" ")).toMatch(/Fal LoRA/);
    expect(checkMediaSetup(setup({ loras: [{ loraId: lora().id, strength: 0.6 }] }), library()).problems.join(" ")).toMatch(/not in this company's LoRA library/);
    expect(
      checkMediaSetup(setup({ loras: [{ loraId: lora().id, strength: 0.6 }] }), library(lora({ archivedAt: new Date() }))).problems.join(" "),
    ).toMatch(/not in this company's LoRA library/);
    expect(
      checkMediaSetup(setup({ loras: [{ loraId: lora().id, strength: 0.6 }, { loraId: lora().id, strength: 0.7 }] }), library(lora())).problems.join(" "),
    ).toMatch(/twice/);
  });

  it("refuses a video setup outside Fal and Sogni, and a picture model in a video setup", () => {
    expect(checkMediaSetup(setup({ provider: "higgsfield", modelId: "soul" }), library()).problems.join(" ")).toMatch(/only use Fal or Sogni/);
    expect(checkMediaSetup(setup({ modelId: "krea2_turbo_fp8_scaled" }), library()).problems.join(" ")).toMatch(/Krea 2 makes image/);
    expect(checkMediaSetup(setup({ kind: "image", provider: "higgsfield", modelId: "soul" }), library()).problems).toEqual([]);
  });

  it("raises the rating to mature for an unreviewed or mature part, and refuses a refused LoRA", () => {
    const unreviewed = lora({ contentTag: "unreviewed" });
    const result = checkMediaSetup(setup({ loras: [{ loraId: unreviewed.id, strength: 0.6 }] }), library(unreviewed));
    expect(result.problems).toEqual([]);
    expect(result.contentRating).toBe("mature");
    expect(result.matureReasons.join(" ")).toMatch(/not been reviewed/);

    // The rules' floor wins over a person's "sfw", and its reason is the one shown.
    const ruled = lora({ ref: "test-mature", name: "Ruled", contentTag: "sfw" });
    const ruledResult = checkMediaSetup(setup({ loras: [{ loraId: ruled.id, strength: 0.8 }] }), library(ruled));
    expect(ruledResult.contentRating).toBe("mature");
    expect(ruledResult.matureReasons).toEqual(['The LoRA "Ruled" is mature by the rules.']);

    const refused = lora({ contentTag: "refused" });
    expect(checkMediaSetup(setup({ loras: [{ loraId: refused.id, strength: 0.6 }] }), library(refused)).problems.join(" ")).toMatch(/refused/);
    const never = lora({ ref: "test-never", name: "Never", contentTag: "sfw" });
    expect(checkMediaSetup(setup({ loras: [{ loraId: never.id, strength: 0.6 }] }), library(never)).problems).toEqual(['The LoRA "Never" is never allowed. Remove it.']);

    const spicy = checkMediaSetup(setup({ modelId: "wan3.0-spicy-video" }), library());
    expect(spicy.contentRating).toBe("mature");
    expect(spicy.matureReasons).toEqual(['The model "wan3.0-spicy-video" is made for mature pictures.']);
    expect(checkMediaSetup(setup({ kind: "image", modelId: "krea2_turbo_fp8_scaled", editModelId: "spicy-edit" }), library()).contentRating).toBe("mature");
  });

  it("needs prompt expansion set explicitly", () => {
    expect(checkMediaSetup(setup({ params: {} }), library()).problems.join(" ")).toMatch(/prompt expansion/);
  });

  it("lists the D4 starters (checked against the real rules in the server's media-content-rules test)", () => {
    expect(MEDIA_STARTER_SETUPS.map((s) => s.name)).toEqual(["Natural", "Natural face & speech", "Action", "Romantic / calm", "Stills (Krea 2)"]);
    expect(MEDIA_STARTER_SETUPS.find((s) => s.key === "action")!.loras).toEqual([{ starterLoraKey: "sogni-h3-better-motion", strength: 0.8 }]);
    expect(MEDIA_STARTER_SETUPS.find((s) => s.key === "romantic-calm")!.loras).toEqual([]);
  });
});

describe("media setups: LoRA library rules", () => {
  const base = {
    provider: "sogni" as const,
    source: "catalog" as const,
    ref: "h3-better-motion",
    name: "Better Motion",
    contentTag: "sfw" as const,
    providerNsfw: false,
    providerSexual: false,
    strengthMin: 0,
    strengthMax: 1.5,
    strengthDefault: 0.6,
    recommendedMin: 0.4,
    recommendedMax: 0.8,
  };

  it("never saves a LoRA the rules refuse in every film, and says why", () => {
    expect(checkMediaLoraFields({ ...base, ref: "test-never", name: "Never" })).toEqual(['The LoRA "Never" is never allowed. It can never be saved.']);
    expect(checkMediaLoraFields({ ...base, ref: "test-never", name: "Never", contentTag: "mature" }).join(" ")).toMatch(/never be saved/);
    expect(effectiveMediaLoraContentTag({ provider: "sogni", source: "catalog", ref: "test-never", contentTag: "sfw" }, rules)).toBe("refused");
  });

  it("does not let a LoRA the rules hold mature be tagged safe for work", () => {
    expect(checkMediaLoraFields({ ...base, ref: "test-mature", name: "Ruled" }).join(" ")).toMatch(/cannot be tagged safe for work; tag it mature/);
    expect(checkMediaLoraFields({ ...base, providerNsfw: true }).join(" ")).toMatch(/cannot be tagged safe for work/);
    expect(checkMediaLoraFields({ ...base, ref: "test-mature", name: "Ruled", contentTag: "mature" })).toEqual([]);
  });

  it("keeps links on Fal and ids on Sogni, and checks the strength scale", () => {
    expect(checkMediaLoraFields({ ...base, source: "url", ref: "https://huggingface.co/a/b.safetensors" }).join(" ")).toMatch(/A link only works on Fal/);
    expect(checkMediaLoraFields({ ...base, provider: "fal" }).join(" ")).toMatch(/Fal takes LoRAs by link/);
    expect(checkMediaLoraFields({ ...base, provider: "fal", source: "url", ref: "http://civitai.com/x" }).join(" ")).toMatch(/https/);
    expect(checkMediaLoraFields({ ...base, provider: "fal", source: "url", ref: "https://u:p@civitai.com/x" }).join(" ")).toMatch(/https/);
    expect(checkMediaLoraFields({ ...base, provider: "fal", source: "url", ref: "https://civitai.com/api/download/models/1" })).toEqual([]);
    expect(checkMediaLoraFields({ ...base, strengthDefault: 2 }).join(" ")).toMatch(/above the highest/);
  });
});

describe("media setups: LoRA links never carry a key", () => {
  const fal = {
    provider: "fal" as const,
    source: "url" as const,
    name: "Link",
    contentTag: "sfw" as const,
    providerNsfw: false,
    providerSexual: false,
    strengthMin: null,
    strengthMax: null,
    strengthDefault: 1,
    recommendedMin: null,
    recommendedMax: null,
  };

  it("refuses a link whose query string or # part holds a key, token, password or signature", () => {
    const links = [
      "https://civitai.com/api/download/models/123?token=abc123secret",
      "https://civitai.com/api/download/models/123?type=Model&Token=abc",
      "https://example.com/l.safetensors?key=abc",
      "https://example.com/l.safetensors?api_key=abc",
      "https://example.com/l.safetensors?apiKey=abc",
      "https://example.com/l.safetensors?x-api-key=abc",
      "https://example.com/l.safetensors?access_token=abc",
      "https://example.com/l.safetensors?auth=abc",
      "https://example.com/l.safetensors?Authorization=Bearer%20abc",
      "https://example.com/l.safetensors?sig=abc&se=2026-01-01",
      "https://bucket.s3.amazonaws.com/l.safetensors?X-Amz-Credential=a&X-Amz-Signature=b",
      "https://storage.googleapis.com/b/l.safetensors?X-Goog-Signature=abc",
      "https://example.com/l.safetensors?password=abc",
      "https://example.com/l.safetensors?secret=abc",
      "https://example.com/l.safetensors?session_id=abc",
      "https://example.com/l.safetensors#access_token=abc",
      "https://example.com/l.safetensors?%74oken=abc",
    ];
    for (const ref of links) {
      expect(mediaLoraLinkSecretParams(ref).length, ref).toBeGreaterThan(0);
      const problems = checkMediaLoraFields({ ...fal, ref });
      expect(problems.join(" "), ref).toMatch(/holds what looks like a key or password/);
      // The message names the part, never its value.
      expect(problems.join(" "), ref).not.toMatch(/abc/);
    }
  });

  it("refuses a Sogni ref that is a link or has a \"?\" or \"#\" part, so no key rides in an id agents see", () => {
    for (const ref of ["https://example.com/l?token=abc", "h3-better-motion?token=abc", "h3-better-motion#abc", "ftp://example.com/abc", "https://example.com/plain"]) {
      for (const source of ["catalog", "personal"] as const) {
        const problems = checkMediaLoraFields({ ...fal, provider: "sogni", source, ref, name: "Sogni" });
        expect(problems.join(" "), `${source} ${ref}`).toMatch(/saved by its id/);
        expect(problems.join(" "), ref).not.toMatch(/abc/);
      }
    }
    expect(checkMediaLoraFields({ ...fal, provider: "sogni", source: "personal", ref: "my-lora-id_12", name: "Sogni" })).toEqual([]);
  });

  it("keeps links whose query string holds no key", () => {
    for (const ref of [
      "https://civitai.com/api/download/models/123?type=Model&format=SafeTensor",
      "https://huggingface.co/acme/motion/resolve/main/motion.safetensors?download=true",
      "https://huggingface.co/acme/motion/blob/main/motion.safetensors#L10",
    ]) {
      expect(mediaLoraLinkSecretParams(ref), ref).toEqual([]);
      expect(checkMediaLoraFields({ ...fal, ref }), ref).toEqual([]);
    }
  });

  it("refuses a setup that uses a stored link with a key", () => {
    const stored = lora({ provider: "fal", source: "url", ref: "https://civitai.com/api/download/models/1?token=abc", name: "Old link", family: null, compatibleModelIds: [] });
    const result = checkMediaSetup(setup({ provider: "fal", modelId: "fal-ai/wan-flf2v", loras: [{ loraId: stored.id, strength: 1 }] }), library(stored));
    expect(result.problems.join(" ")).toMatch(/link of the LoRA "Old link" holds what looks like a key/);
  });

  it("shows agents a link without its query string or # part", () => {
    expect(mediaLoraRefForAgents({ source: "url", ref: "https://civitai.com/api/download/models/1?type=Model&format=SafeTensor" })).toBe("https://civitai.com/api/download/models/1");
    expect(mediaLoraRefForAgents({ source: "url", ref: "https://user@huggingface.co/a/b.safetensors#x" })).toBe("https://huggingface.co/a/b.safetensors");
    expect(mediaLoraRefForAgents({ source: "url", ref: "not a link?token=x" })).toBe("not a link");
    expect(mediaLoraRefForAgents({ source: "catalog", ref: "h3-better-motion" })).toBe("h3-better-motion");
    // A Sogni ref saved before ids with a link or "?" were refused is cut down for agents too.
    expect(mediaLoraRefForAgents({ source: "catalog", ref: "h3-better-motion?token=abc" })).toBe("h3-better-motion");
    expect(mediaLoraRefForAgents({ source: "personal", ref: "https://user:pw@example.com/l?token=abc" })).toBe("https://example.com/l");
  });
});

describe("media setups: request schemas", () => {
  it("needs an explicit strength on every LoRA and an explicit prompt expansion", () => {
    const loraId = "11111111-1111-4111-8111-111111111111";
    expect(createMediaSetupSchema.safeParse({ kind: "video", name: "x", provider: "sogni", modelId: "m", params: {} }).success).toBe(false);
    expect(
      createMediaSetupSchema.safeParse({ kind: "video", name: "x", provider: "sogni", modelId: "m", params: { promptExpansion: false }, loras: [{ loraId }] }).success,
    ).toBe(false);
    const ok = createMediaSetupSchema.parse({ kind: "video", name: "x", provider: "sogni", modelId: "m", params: { promptExpansion: true }, loras: [{ loraId, strength: 0.6 }] });
    expect(ok.status).toBe("draft");
    expect(createMediaSetupSchema.safeParse({ kind: "video", name: "x", provider: "sogni", modelId: "m", params: { promptExpansion: true }, status: "archived" }).success).toBe(false);
  });

  it("defaults a LoRA to unreviewed at 0.6 and keeps scores between 1 and 5", () => {
    const parsed = createMediaLoraSchema.parse({ provider: "sogni", source: "catalog", ref: "h3-better-motion", name: "Better Motion" });
    expect(parsed).toMatchObject({ contentTag: "unreviewed", strengthDefault: 0.6, triggerWords: [] });
    expect(createMediaSetupTrialSchema.safeParse({ scores: { naturalness: 6 } }).success).toBe(false);
    expect(createMediaSetupTrialSchema.safeParse({ scores: { looks: 3 } }).success).toBe(false);
    expect(createMediaSetupTrialSchema.parse({ scores: { naturalness: 4, movement: 5 } }).raterKind).toBe("human");
  });
});

describe("media setups: params never touch a provider's safety filter", () => {
  const base = { kind: "video", name: "x", provider: "fal", modelId: "fal-ai/wan-flf2v" } as const;
  const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
    (result.error?.issues ?? []).map((issue) => issue.message).join(" ");

  it("refuses safety, filter and tolerance switches with a plain reason", () => {
    const fal = createMediaSetupSchema.safeParse({ ...base, params: { promptExpansion: false, enable_safety_checker: false, safety_tolerance: "6" } });
    expect(fal.success).toBe(false);
    expect(messages(fal)).toMatch(/"enable_safety_checker" would change the service's safety filter/);
    expect(messages(fal)).toMatch(/"safety_tolerance" would change the service's safety filter/);
    for (const key of ["disableNSFWFilter", "enable_output_safety_checker", "safetyChecker", "content-moderation", "uncensored"]) {
      const result = createMediaSetupSchema.safeParse({ ...base, provider: "sogni", modelId: "krea2_turbo_fp8_scaled", kind: "image", params: { promptExpansion: false, [key]: true } });
      expect(result.success, key).toBe(false);
      expect(messages(result), key).toMatch(/safety filter/);
    }
    // Patching params alone is checked the same way.
    expect(updateMediaSetupSchema.safeParse({ params: { promptExpansion: false, disableNSFWFilter: true } }).success).toBe(false);
  });

  it("allows only the listed settings, each with a value that fits", () => {
    const unknown = createMediaSetupSchema.safeParse({ ...base, params: { promptExpansion: false, loraScale: 2 } });
    expect(unknown.success).toBe(false);
    expect(messages(unknown)).toMatch(/"loraScale" is not a setting a setup can carry/);
    expect(createMediaSetupSchema.safeParse({ ...base, params: { promptExpansion: false, steps: 0 } }).success).toBe(false);
    expect(createMediaSetupSchema.safeParse({ ...base, params: { promptExpansion: false, aspectRatio: "wide" } }).success).toBe(false);
    expect(createMediaSetupSchema.safeParse({ ...base, params: [] }).success).toBe(false);
    const ok = createMediaSetupSchema.parse({
      ...base,
      params: { promptExpansion: true, seed: 42, steps: 30, guidance: 3.5, aspectRatio: "16:9", negativePrompt: "blurry", durationSeconds: 5, fps: 24, resolution: "720p", sampler: null },
    });
    expect(ok.params).toMatchObject({ promptExpansion: true, seed: 42, aspectRatio: "16:9" });
  });

  it("flags a stored safety switch as a problem and never passes it on", () => {
    const stored = { promptExpansion: false, disableNSFWFilter: true, seed: 7 };
    const result = checkMediaSetup(setup({ provider: "sogni", kind: "image", modelId: "krea2_turbo_fp8_scaled", params: stored }), library());
    expect(result.problems.join(" ")).toMatch(/"disableNSFWFilter" would change the service's safety filter/);
    expect(mediaSetupParamProblems({ promptExpansion: false, seed: 7 })).toEqual([]);
    expect(pickMediaSetupParams(stored)).toEqual({ promptExpansion: false, seed: 7 });
  });
});

describe("media setups: register summary", () => {
  it("averages people's and an AI judge's scores apart and computes the tendency", () => {
    const summary = summarizeMediaSetupTrials(
      [
        { scores: { naturalness: 4, movement: 3 }, raterKind: "human", flaggedByCheck: false, flaggedByProvider: false, costCents: 40, secondsTaken: 90 },
        { scores: { naturalness: 5 }, raterKind: "human", flaggedByCheck: true, flaggedByProvider: false, costCents: 60, secondsTaken: null },
        { scores: { naturalness: 2 }, raterKind: "ai", flaggedByCheck: false, flaggedByProvider: false, costCents: null, secondsTaken: 30 },
      ],
      "sfw",
    );
    expect(summary.humanScores.naturalness).toBe(4.5);
    expect(summary.humanScores.movement).toBe(3);
    expect(summary.humanScores.faceContinuity).toBeNull();
    expect(summary.aiScores.naturalness).toBe(2);
    expect(summary.flaggedCount).toBe(1);
    expect(summary.sfwTendency).toBe("leans_mature");
    expect(summary.averageCostCents).toBe(50);
    expect(summary.averageSeconds).toBe(60);
    expect(summarizeMediaSetupTrials([], "mature").sfwTendency).toBe("mature");
    expect(summarizeMediaSetupTrials([], "sfw").sfwTendency).toBe("sfw");
  });
});

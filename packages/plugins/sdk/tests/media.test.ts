import { describe, expect, it, vi } from "vitest";
import {
  ANATOMY_SLIDER_LORA_IDS,
  FILTER_BYPASS_LORA_IDS,
  FLAGGED_LORA_IDS,
  REVIEWED_LORA_IDS,
  SAFE_FOR_WORK_AVOID,
  SOGNI_LORA_CATALOG_URL,
  SOGNI_LORA_CATALOG_TTL_MS,
  SogniLoraCatalogCache,
  classifyLoras,
  evaluateLora,
  evaluateModel,
  loraPolicyInput,
  lorasForModel,
  modelContentTags,
  parseSogniLoraCatalog,
  type SogniLoraInfo,
} from "../src/media/index.js";

function row(loraId: string, ui: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    loraId,
    name: `Name of ${loraId}`,
    modelIds: ["krea-2-turbo"],
    ui: { min: 0, max: 1, default: 1, step: 0.1, category: "character", nsfw: false, sexual: false, ...ui },
    ...extra,
  };
}

function catalogBody(rows: unknown[], extra: Record<string, unknown> = {}) {
  return { status: "success", data: { loras: rows, models: ["krea-2-turbo"], constraints: { maxPerRequest: 4 }, ...extra } };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("media: LoRA deny rules", () => {
  it("refuses both filter-bypass LoRAs in every mode, though the catalog leaves them unflagged", () => {
    expect(FILTER_BYPASS_LORA_IDS).toEqual(["krea2-filter-bypass-2", "krea2-filter-bypass-3"]);
    for (const id of FILTER_BYPASS_LORA_IDS) {
      for (const mode of ["sfw", "mature"] as const) {
        const verdict = evaluateLora({ id, category: "prompt-control", nsfw: false, sexual: false }, mode);
        expect(verdict).toMatchObject({ allowed: false, reason: "filter-bypass", alwaysRefused: true });
      }
    }
  });

  it("refuses a filter-bypass LoRA that is renamed or numbered later", () => {
    expect(evaluateLora({ id: "krea2-filter-bypass-4", category: "prompt-control" }, "mature").allowed).toBe(false);
    expect(evaluateLora({ id: "something-new", name: "Krea2FilterBypass 9vector" }, "mature").allowed).toBe(false);
  });

  it("refuses the three anatomy sliders in SFW and allows them in mature", () => {
    expect(ANATOMY_SLIDER_LORA_IDS).toEqual(["krea2-breast", "krea2-chest-firmness", "krea2-nipple-projection"]);
    for (const id of ANATOMY_SLIDER_LORA_IDS) {
      expect(REVIEWED_LORA_IDS.has(id)).toBe(true);
      expect(evaluateLora({ id, category: "character", nsfw: false, sexual: false }, "sfw")).toMatchObject({
        allowed: false,
        reason: "anatomy-slider",
        alwaysRefused: false,
      });
      expect(evaluateLora({ id, category: "character" }, "mature").allowed).toBe(true);
    }
  });

  it("refuses LoRAs Sogni flags nsfw or sexual in SFW", () => {
    expect(evaluateLora({ id: "krea2-aberrant", nsfw: true, sexual: false }, "sfw")).toMatchObject({ allowed: false, reason: "nsfw-flag" });
    expect(evaluateLora({ id: "krea2-aberrant", nsfw: false, sexual: true }, "sfw")).toMatchObject({ allowed: false, reason: "sexual-flag" });
    expect(evaluateLora({ id: "krea2-aberrant", nsfw: true, sexual: true }, "mature").allowed).toBe(true);
  });

  it("refuses the three LoRAs Sogni flagged at review by id alone, with no flags passed", () => {
    expect(FLAGGED_LORA_IDS).toEqual(["krea2-aberrant", "krea2-realism-engine", "h3-vbvr-video-reasoning"]);
    for (const id of FLAGGED_LORA_IDS) {
      expect(REVIEWED_LORA_IDS.has(id)).toBe(true);
      expect(evaluateLora({ id }, "sfw")).toMatchObject({ allowed: false, reason: "nsfw-flag", alwaysRefused: false });
      expect(evaluateLora({ id, nsfw: false, sexual: false, personal: true }, "sfw").allowed).toBe(false);
      expect(evaluateLora({ id }, "mature").allowed).toBe(true);
    }
  });

  it("refuses filter-bypass names with other separators or dash characters in every mode", () => {
    for (const name of ["filter.bypass 4", "Filter\u2013Bypass", "filter\u2014bypass", "FILTER_BYPASS"]) {
      expect(evaluateLora({ id: "something-new", name }, "mature")).toMatchObject({ allowed: false, reason: "filter-bypass" });
    }
  });

  it("refuses the whole Mystic X family in SFW, by id or name", () => {
    for (const id of ["krea2-mystic-x", "h3-mystic-xxx-v4", "h3-mystic-xxx-v5", "moss-mystic-x"]) {
      // Even if Sogni dropped its flags.
      expect(evaluateLora({ id, nsfw: false, sexual: false }, "sfw")).toMatchObject({ allowed: false, reason: "mystic-x" });
    }
    expect(evaluateLora({ id: "new-id", name: "Mystic X v6" }, "sfw")).toMatchObject({ allowed: false, reason: "mystic-x" });
    expect(evaluateLora({ id: "krea2-mystic-x" }, "mature").allowed).toBe(true);
  });

  it("counts a LoRA outside the reviewed snapshot as mature", () => {
    const verdict = evaluateLora({ id: "krea2-brand-new", category: "art-direction", nsfw: false, sexual: false }, "sfw");
    expect(verdict).toMatchObject({ allowed: false, reason: "unreviewed" });
    expect(verdict.message).toContain("review");
    expect(evaluateLora({ id: "krea2-brand-new" }, "mature").allowed).toBe(true);
  });

  it("does not apply the unreviewed rule to the account's own LoRAs", () => {
    expect(evaluateLora({ id: "personal-abc123", personal: true }, "sfw").allowed).toBe(true);
    // ...but the name rules still do.
    expect(evaluateLora({ id: "personal-abc123", name: "Mystic X copy", personal: true }, "sfw").allowed).toBe(false);
  });

  it("allows an ordinary reviewed LoRA in SFW", () => {
    for (const id of ["krea2-detail-enhancer", "krea2-warm-light", "moss-canon-ultrareal"]) {
      expect(evaluateLora({ id, category: "detail-composition", nsfw: false, sexual: false }, "sfw")).toMatchObject({ allowed: true, reason: null, message: null });
    }
  });

  it("reads the rules from a parsed catalog row", () => {
    const parsed = parseSogniLoraCatalog(catalogBody([row("krea2-mystic-x", { nsfw: true, sexual: true }), row("krea2-warm-light")]));
    const [mystic, warm] = parsed!.loras;
    expect(mystic).toMatchObject({ needsFilterOff: true, sexual: true });
    expect(evaluateLora(loraPolicyInput(mystic!), "sfw").allowed).toBe(false);
    expect(evaluateLora(loraPolicyInput(warm!), "sfw").allowed).toBe(true);
  });
});

describe("media: model content tags", () => {
  const refused = [
    "dark_beast_krea2_fp8",
    "dark-beast-z-turbo",
    "dark_beast_z_image_turbo_v9_bf16",
    "dark_beast_krea2_identity_edit_v1_2",
    "wan3.0-spicy-video",
    "seedance-2-5-uncensored",
    "seedance-2-0-mini-uncensored",
    "seedream-5-0-pro-uncensored",
    "ltx23-22b-10eros-v1.4-fp8mixed_i2v",
    "ltx23-eros",
    "sogni/dark_beast_x",
    "flux1-darkbeast",
  ];
  it.each(refused)("refuses %s in SFW and allows it in mature", (id) => {
    expect(modelContentTags({ id }).length).toBeGreaterThan(0);
    expect(evaluateModel({ id }, "sfw")).toMatchObject({ allowed: false, reason: "mature-model" });
    expect(evaluateModel({ id }, "mature").allowed).toBe(true);
  });

  it("tags dark-beast as off-required and uses Sogni's own mature/off-required/spicy tags", () => {
    expect(modelContentTags({ id: "dark_beast_krea2_fp8" })).toContain("off-required");
    expect(modelContentTags({ id: "x", tags: ["spicy"] })).toEqual(["spicy"]);
    expect(modelContentTags({ id: "x", tags: ["mature"] })).toEqual(["mature"]);
    expect(modelContentTags({ id: "x", tags: ["off-required"] })).toEqual(["off-required"]);
    expect(modelContentTags({ id: "seedance-2-5-uncensored" })).toContain("uncensored");
    expect(modelContentTags({ id: "ltx23-eros" })).toEqual(expect.arrayContaining(["mature", "spicy"]));
    expect(evaluateModel({ id: "one_obsession_v22_fp16", tags: ["new", "spicy"] }, "sfw").allowed).toBe(false);
  });

  it("does not refuse the models Sogni merely tags 'uncensored' (that tag sits on the default Z-Image Turbo)", () => {
    for (const id of ["z_image_turbo_bf16", "z-turbo", "chroma1_hd_8bit", "krea-2-turbo", "gpt-image-2", "seedance-2-0", "ltx23-22b-fp8_t2v_distilled"]) {
      expect(evaluateModel({ id, tags: ["standard", "uncensored"] }, "sfw")).toMatchObject({ allowed: true });
    }
  });
});

describe("media: SAFE_FOR_WORK_AVOID", () => {
  it("keeps the text the worker has always sent", () => {
    expect(SAFE_FOR_WORK_AVOID).toBe("nudity, nsfw, text, letters, words, watermark, logo");
  });
});

describe("media: LoRA catalog parse", () => {
  it("drops restricted models, bad rows and caps maxPerRequest", () => {
    const parsed = parseSogniLoraCatalog(
      catalogBody(
        [row("a", {}, { modelIds: ["m1", "m2"], restrictedModelIds: ["m2"] }), { loraId: "bad" }, row("c", { min: 2, max: 1 })],
        { constraints: { maxPerRequest: 50 } },
      ),
    );
    expect(parsed!.loras.map((l) => l.id)).toEqual(["a"]);
    expect(parsed!.loras[0]!.modelIds).toEqual(["m1"]);
    expect(parsed!.maxPerRequest).toBe(8);
    expect(parseSogniLoraCatalog({ data: {} })).toBeNull();
    expect(parseSogniLoraCatalog(null)).toBeNull();
  });

  it("lists the LoRAs for one model", () => {
    const parsed = parseSogniLoraCatalog(catalogBody([row("a"), row("b", {}, { modelIds: ["other"] })]));
    expect(lorasForModel(parsed, "krea-2-turbo").map((l) => l.id)).toEqual(["a"]);
    expect(lorasForModel(null, "krea-2-turbo")).toEqual([]);
  });
});

describe("media: SogniLoraCatalogCache", () => {
  it("reads only the fixed Sogni URL and caches for ten minutes", async () => {
    let t = 1_000;
    const fetch = vi.fn(async (_url: string) => reply(catalogBody([row("a")])));
    const cache = new SogniLoraCatalogCache({ fetch, now: () => t });
    expect(SOGNI_LORA_CATALOG_URL).toBe("https://api.sogni.ai/v1/loras/comfy");
    expect((await cache.get())!.loras).toHaveLength(1);
    t += SOGNI_LORA_CATALOG_TTL_MS - 1;
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.sogni.ai/v1/loras/comfy");
    t += 2;
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps separate caches per instance", async () => {
    const fetch = vi.fn(async () => reply(catalogBody([row("a")])));
    await new SogniLoraCatalogCache({ fetch }).get();
    await new SogniLoraCatalogCache({ fetch }).get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const fetch = vi.fn(async () => reply(catalogBody([row("a")])));
    const cache = new SogniLoraCatalogCache({ fetch });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last list when Sogni fails, and waits before asking again", async () => {
    let t = 0;
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return reply(catalogBody([row("a")]));
    });
    const cache = new SogniLoraCatalogCache({ fetch, now: () => t });
    await cache.get();
    fail = true;
    t += SOGNI_LORA_CATALOG_TTL_MS + 1;
    expect((await cache.get())!.loras[0]!.id).toBe("a");
    expect(fetch).toHaveBeenCalledTimes(2);
    t += 5_000;
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    t += 30_000;
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("answers null with no list at all (error status, bad JSON, wrong shape)", async () => {
    for (const make of [() => reply({}, 500), () => new Response("<html>", { status: 200 }), () => reply({ data: {} })]) {
      expect(await new SogniLoraCatalogCache({ fetch: async () => make() }).get()).toBeNull();
    }
    expect(await new SogniLoraCatalogCache({ fetch: async () => Promise.reject(new Error("x")) }).get()).toBeNull();
  });
});

describe("media: classifyLoras", () => {
  const known: SogniLoraInfo[] = parseSogniLoraCatalog(catalogBody([row("fits"), row("elsewhere", {}, { modelIds: ["other-model"] })]))!.loras;
  const model = { id: "krea-2-turbo", name: "Krea 2 Turbo" };

  it("sorts picks into fits, other-models and unknown", () => {
    const checks = classifyLoras(model, [{ id: "fits" }, { id: "elsewhere" }, { id: "gone", name: "Gone" }], known, { "other-model": "Other Model" });
    expect(checks.map((c) => [c.id, c.fit])).toEqual([
      ["fits", "fits"],
      ["elsewhere", "other-models"],
      ["gone", "unknown"],
    ]);
    expect(checks[1]!.madeFor).toEqual(["Other Model"]);
    expect(checks[1]!.warning).toBe("Made for Other Model; Krea 2 Turbo may ignore it or give odd results.");
    expect(checks[2]!.warning).toContain("does not list this LoRA");
    expect(checks[0]!.warning).toBeNull();
  });

  it("says the list could not be read when it is null", () => {
    const [check] = classifyLoras(model, [{ id: "fits" }], null);
    expect(check).toMatchObject({ fit: "unknown" });
    expect(check!.warning).toContain("could not be read");
  });
});

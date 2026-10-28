import { describe, expect, it } from "vitest";
import {
  MEDIA_STARTER_LORAS,
  MEDIA_STARTER_SETUPS,
  checkMediaLoraFields,
  checkMediaSetup,
  effectiveMediaLoraContentTag,
  type MediaLoraForCheck,
  type MediaSetupForCheck,
} from "@paperclipai/shared";
import { mediaContentRules } from "../services/media-content-rules.js";

// Model setups and the LoRA library use the Media Studio safety module's own
// rules (@paperclipai/plugin-sdk/media evaluateLora / evaluateModel), with no
// copy of their lists (SR2 review of PR #683, F1).

type LoraFields = Parameters<typeof checkMediaLoraFields>[0];

const base: LoraFields = {
  provider: "sogni",
  source: "catalog",
  ref: "h3-better-motion",
  name: "Better Motion",
  contentTag: "sfw",
  providerNsfw: false,
  providerSexual: false,
  strengthMin: 0,
  strengthMax: 1.5,
  strengthDefault: 0.6,
  recommendedMin: 0.4,
  recommendedMax: 0.8,
};

function lora(overrides: Partial<MediaLoraForCheck> = {}): MediaLoraForCheck {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "sogni",
    source: "catalog",
    ref: "krea2-detail-enhancer",
    name: "Detail",
    family: "krea2",
    compatibleModelIds: [],
    contentTag: "sfw",
    providerNsfw: false,
    providerSexual: false,
    strengthMin: 0,
    strengthMax: 2,
    triggerWords: [],
    archivedAt: null,
    ...overrides,
  };
}

function pictureSetup(loraIds: string[], overrides: Partial<MediaSetupForCheck> = {}): MediaSetupForCheck {
  return {
    kind: "image",
    provider: "sogni",
    modelId: "krea2_turbo_fp8_scaled",
    mode: null,
    editModelId: null,
    loras: loraIds.map((loraId) => ({ loraId, strength: 0.6 })),
    params: { promptExpansion: false },
    ...overrides,
  };
}

const fields = (overrides: Partial<LoraFields>) => checkMediaLoraFields({ ...base, ...overrides }, mediaContentRules);

describe("media setups use the safety module's rules", () => {
  it("never saves the age slider, the filter-bypass LoRAs or a jailbreak, whatever they are tagged", () => {
    for (const [ref, name] of [
      ["krea2-age", "Age"],
      ["krea2-unfilter", "Unfilter"],
      ["krea2-jailbreak", "Jailbreak"],
      ["krea2-filter-bypass-2", "Filter Bypass 2"],
      ["krea2-filter-bypass-3", "Filter Bypass 3"],
      ["krea2-new-thing", "Bypass the filter"],
      ["krea2-new-thing", "No​Filter"],
      ["krea2-new-thing", "Filter-Byp4ss 4"],
      ["krea2-new-slider", "Younger <-> Older"],
      ["personal-abc", "Teen look"],
    ] as const) {
      const source = ref.startsWith("personal-") ? "personal" : "catalog";
      for (const contentTag of ["sfw", "mature", "unreviewed"] as const) {
        expect(fields({ ref, name, contentTag, source }).join(" "), `${ref} / ${name} / ${contentTag}`).toMatch(/never be saved/);
        expect(effectiveMediaLoraContentTag({ provider: "sogni", source, ref, name, contentTag }, mediaContentRules), ref).toBe("refused");
      }
    }
    expect(fields({ ref: "krea2-age", name: "Age" })).toEqual([
      'The LoRA "Age" changes how old a person looks and is not allowed, because it could make a person look under-age. It can never be saved.',
    ]);
  });

  it("refuses a Fal link whose file or name says filter bypass or age", () => {
    const link: Partial<LoraFields> = { provider: "fal", source: "url", strengthMin: null, strengthMax: null, strengthDefault: 1, recommendedMin: null, recommendedMax: null };
    expect(fields({ ...link, ref: "https://huggingface.co/x/y/resolve/main/age-slider.safetensors", name: "Slider" }).join(" ")).toMatch(/never be saved/);
    expect(fields({ ...link, ref: "https://huggingface.co/x/y/resolve/main/style.safetensors", name: "Jailbreak style" }).join(" ")).toMatch(/never be saved/);
    // An ordinary link: a person's review decides (the reviewed list is Sogni's catalog only).
    expect(fields({ ...link, ref: "https://huggingface.co/acme/motion/resolve/main/motion.safetensors", name: "Acme motion" })).toEqual([]);
  });

  it("does not let a LoRA the module holds mature be tagged safe for work", () => {
    for (const ref of ["krea2-breast", "krea2-chest-firmness", "krea2-nipple-projection", "krea2-aberrant", "krea2-realism-engine", "h3-vbvr-video-reasoning", "krea2-mystic-x", "moss-mystic-x"]) {
      expect(fields({ ref, name: ref }).join(" "), ref).toMatch(/cannot be tagged safe for work; tag it mature/);
      expect(fields({ ref, name: ref, contentTag: "mature" }), ref).toEqual([]);
    }
    expect(fields({ providerNsfw: true }).join(" ")).toMatch(/marked not safe for work by Sogni/);
    expect(fields({ providerSexual: true }).join(" ")).toMatch(/marked sexual by Sogni/);
    // A Sogni catalog id that is not in the reviewed snapshot counts as mature until a release reviews it.
    expect(fields({ ref: "krea2-brand-new", name: "Brand new" }).join(" ")).toMatch(/has not been reviewed yet/);
    expect(fields({ ref: "krea2-brand-new", name: "Brand new", contentTag: "mature" })).toEqual([]);
    // Reviewed and unflagged: a person may tag it safe for work.
    expect(fields({ ref: "h3-realism-people", name: "Realism People" })).toEqual([]);
  });

  it("refuses a setup with an always-refused LoRA, and rates mature LoRAs and models mature", () => {
    const age = lora({ id: "22222222-2222-4222-8222-222222222222", ref: "krea2-age", name: "Age", contentTag: "sfw" });
    const ageResult = checkMediaSetup(pictureSetup([age.id]), new Map([[age.id, age]]), mediaContentRules);
    expect(ageResult.problems.join(" ")).toMatch(/changes how old a person looks.*Remove it/);

    const breast = lora({ id: "33333333-3333-4333-8333-333333333333", ref: "krea2-breast", name: "Breast", contentTag: "sfw" });
    const breastResult = checkMediaSetup(pictureSetup([breast.id]), new Map([[breast.id, breast]]), mediaContentRules);
    expect(breastResult.problems).toEqual([]);
    expect(breastResult.contentRating).toBe("mature");
    expect(breastResult.matureReasons.join(" ")).toMatch(/changes body anatomy/);

    for (const modelId of ["krea2-nsfw-v2", "dark_beast_krea2_fp8", "wan3.0-spicy-video", "seedream-5-0-pro-uncensored"]) {
      const kind = modelId.startsWith("wan3") ? "video" : "image";
      const result = checkMediaSetup(pictureSetup([], { kind, modelId }), new Map(), mediaContentRules);
      expect(result.contentRating, modelId).toBe("mature");
      expect(result.matureReasons.join(" "), modelId).toMatch(/made for mature pictures/);
    }
    const eros = checkMediaSetup(pictureSetup([], { kind: "video", modelId: "ltx23-eros" }), new Map(), mediaContentRules);
    expect(eros.contentRating).toBe("mature");
    const edit = checkMediaSetup(pictureSetup([], { editModelId: "flux-nsfw-edit" }), new Map(), mediaContentRules);
    expect(edit.contentRating).toBe("mature");
    expect(checkMediaSetup(pictureSetup([]), new Map(), mediaContentRules).contentRating).toBe("sfw");
  });

  it("accepts every starter setup with the starter LoRAs, all safe for work", () => {
    const rows = MEDIA_STARTER_LORAS.map((starter, index) =>
      lora({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        ref: starter.ref,
        name: starter.name,
        family: starter.family,
        compatibleModelIds: [...starter.compatibleModelIds],
        contentTag: starter.contentTag,
        strengthMin: starter.strengthMin,
        strengthMax: starter.strengthMax,
      }),
    );
    for (const row of rows) expect(effectiveMediaLoraContentTag(row, mediaContentRules), row.ref).toBe("sfw");
    const byKey = new Map(MEDIA_STARTER_LORAS.map((starter, index) => [starter.key, rows[index]!.id]));
    for (const starter of MEDIA_STARTER_SETUPS) {
      const result = checkMediaSetup(
        {
          kind: starter.kind,
          provider: starter.provider,
          modelId: starter.modelId,
          mode: starter.mode,
          editModelId: null,
          loras: starter.loras.map((pick) => ({ loraId: byKey.get(pick.starterLoraKey)!, strength: pick.strength })),
          params: starter.params,
        },
        new Map(rows.map((row) => [row.id, row])),
        mediaContentRules,
      );
      expect(result.problems, starter.name).toEqual([]);
      expect(result.contentRating, starter.name).toBe("sfw");
    }
  });
});

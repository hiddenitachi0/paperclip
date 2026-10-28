import { describe, expect, it } from "vitest";
import { FalFlaggedError, type SogniLoraInfo } from "@paperclipai/plugin-sdk/media";
import {
  assertFilmModelAllowed,
  filmContentFilter,
  filmContentMode,
  filmLoras,
  filmPictureText,
  filmVideoPrompt,
} from "../services/film-content-rules.ts";
import { FalImageProvider } from "../services/image-provider-clients.ts";
import { FalDirectPictureProvider } from "../services/media-studio-direct-providers.ts";
import { FalVideoProvider } from "../services/video-provider-clients.ts";
import { FalProvider } from "../../../packages/plugins/media-studio/src/providers.js";
import { falQueuePoll, falQueueSubmit } from "../../../packages/plugins/media-studio/src/fal-queue.js";

/** DUR-4898: the rating rules each request obeys, and the provider-level safety fields. Stubbed HTTP only. */

function lora(id: string): SogniLoraInfo {
  return {
    id, name: `Name ${id}`, description: "", category: null, personal: false, modelIds: [], min: 0, max: 1, default: 1, step: 0.1,
    recommendedMin: 0, recommendedMax: 1, rangeLabels: null, needsFilterOff: false, sexual: false, creator: null, sourceUrl: null,
  };
}

describe("film rating rules", () => {
  it("reads a missing or odd rating as safe for work", () => {
    expect(filmContentMode({ contentRating: "mature" })).toBe("mature");
    for (const row of [{ contentRating: "sfw" }, { contentRating: "MATURE" }, { contentRating: null }, {}, null, undefined]) {
      expect(filmContentMode(row)).toBe("sfw");
    }
  });

  it("refuses spicy, uncensored, Dark Beast and Eros models in a safe-for-work film, in pictures and in video", () => {
    for (const model of ["dark-beast-krea2", "wan3.0-spicy-video", "seedance2-mini-uncensored", "ltx23-eros", "seedream-5-0-pro-uncensored"]) {
      expect(() => assertFilmModelAllowed(model, "sfw"), model).toThrowError(/made for mature pictures/);
      expect(() => assertFilmModelAllowed(model, "mature"), model).not.toThrow();
    }
    for (const model of ["z-turbo", "krea-2-turbo", "ltx25", "fal-ai/kling-video/v3/pro/image-to-video", null, undefined, ""]) {
      expect(() => assertFilmModelAllowed(model, "sfw"), String(model)).not.toThrow();
    }
  });

  it("filter-bypass LoRAs stop the request in every film; flagged and slider LoRAs are dropped with a note in SFW only", () => {
    const known = [lora("krea2-realism"), lora("krea2-breast"), lora("krea2-filter-bypass-2")];
    for (const mode of ["sfw", "mature"] as const) {
      expect(() => filmLoras([{ id: "krea2-filter-bypass-2" }], mode, known)).toThrowError(/never allowed/);
      expect(() => filmLoras([{ id: "krea2-filter-bypass-2" }], mode, null)).toThrowError(/never allowed/);
    }
    const sfw = filmLoras([{ id: "krea2-realism" }, { id: "krea2-breast" }, { id: "krea2-new-thing" }], "sfw", known);
    expect(sfw.loras).toEqual([{ id: "krea2-realism" }]);
    expect(sfw.notes).toHaveLength(2);
    expect(filmLoras([{ id: "krea2-breast" }], "mature", known).loras).toHaveLength(1);
  });

  it("the Sogni filter is on in a safe-for-work film whatever the look says; a mature film never turns it off by itself", () => {
    expect(filmContentFilter("sfw", false)).toMatchObject({ safeContentFilter: true, note: expect.stringContaining("stayed on") });
    expect(filmContentFilter("sfw", true)).toEqual({ safeContentFilter: true, note: null });
    expect(filmContentFilter("sfw", null)).toEqual({ safeContentFilter: true, note: null });
    expect(filmContentFilter("mature", null)).toEqual({ safeContentFilter: true, note: null });
    expect(filmContentFilter("mature", true)).toEqual({ safeContentFilter: true, note: null });
    expect(filmContentFilter("mature", false)).toEqual({ safeContentFilter: false, note: null });
  });

  it("safe-for-work words go in the negative field only where the request has one", () => {
    const withNegative = filmPictureText("sfw", { prompt: "A harbour", negativePrompt: "blurry" }, true);
    expect(withNegative.prompt).toContain("Fully clothed.");
    expect(withNegative.prompt).not.toContain("Keep out");
    expect(withNegative.negativePrompt).toBe("blurry, nudity, nsfw, text, letters, words, watermark, logo");
    const without = filmPictureText("sfw", { prompt: "A harbour" }, false);
    expect(without.prompt).toContain("Fully clothed. Keep out of the picture: nudity");
    expect(without.negativePrompt).toBeUndefined();
    // Too long for the negative field: it moves into the prompt.
    const long = filmPictureText("sfw", { prompt: "x", negativePrompt: "y".repeat(990) }, true);
    expect(long.prompt).toContain("Keep out of the picture: nudity");
    expect(filmPictureText("mature", { prompt: "A harbour" }, true)).toEqual({ prompt: "A harbour" });
    expect(filmVideoPrompt("sfw", "A walk")).toContain("Fully clothed.");
    expect(filmVideoPrompt("mature", "A walk")).toBe("A walk");
  });
});

function recorder(reply: (url: string) => unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.body) calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(reply(url)), { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("Fal requests carry the safety fields", () => {
  it("every Fal video request has enable_safety_checker; the Wan endpoints (default OFF) also get the output check; Veo 3.1 gets safety_tolerance 1", async () => {
    const wan = ["fal-ai/wan-i2v-lora", "fal-ai/wan-flf2v", "fal-ai/wan/v2.2-a14b/text-to-video/lora", "fal-ai/wan/v2.2-a14b/image-to-video"];
    for (const model of wan) {
      const rec = recorder(() => ({ request_id: "r1" }));
      await new FalVideoProvider("k", rec.fetchImpl).start({ kind: "video", prompt: "p", model, startImage: "data:image/png;base64,AA==" });
      expect(rec.calls[0]!.body, model).toMatchObject({ enable_safety_checker: true, enable_output_safety_checker: true });
    }
    const veo = recorder(() => ({ request_id: "r1" }));
    await new FalVideoProvider("k", veo.fetchImpl).start({ kind: "video", prompt: "p", model: "fal-ai/veo3.1/image-to-video", startImage: "data:image/png;base64,AA==" });
    expect(veo.calls[0]!.body).toMatchObject({ enable_safety_checker: true, safety_tolerance: "1" });
    const kling = recorder(() => ({ request_id: "r1" }));
    await new FalVideoProvider("k", kling.fetchImpl).start({ kind: "video", prompt: "p" });
    expect(kling.calls[0]!.body).toMatchObject({ enable_safety_checker: true });
  });

  it("the safety fields are the last keys in the body, so nothing earlier can turn a check off", async () => {
    const rec = recorder(() => ({ request_id: "r1" }));
    await new FalVideoProvider("k", rec.fetchImpl).start({ kind: "video", prompt: "p", model: "fal-ai/wan-i2v-lora", startImage: "data:image/png;base64,AA==" });
    expect(Object.keys(rec.calls[0]!.body).slice(-2)).toEqual(["enable_safety_checker", "enable_output_safety_checker"]);
  });

  it("a Fal clip flagged by has_nsfw_concepts is a failure, never a finished clip", async () => {
    const rec = recorder((url) => {
      if (url.endsWith("/status")) return { status: "COMPLETED" };
      return { video: { url: "https://v3.fal.media/x.mp4" }, has_nsfw_concepts: [true] };
    });
    const outcome = await new FalVideoProvider("k", rec.fetchImpl).poll({ externalId: "r1", model: "fal-ai/wan-i2v-lora", provider: "fal" });
    // `flagged`: Fal still bills it, so the render records the cost instead of releasing the money it held.
    expect(outcome).toMatchObject({ status: "failed", flagged: true, error: expect.stringContaining("safety check flagged") });
    const ok = recorder((url) => (url.endsWith("/status") ? { status: "COMPLETED" } : { video: { url: "https://v3.fal.media/x.mp4" }, has_nsfw_concepts: [false] }));
    expect((await new FalVideoProvider("k", ok.fetchImpl).poll({ externalId: "r1", model: "fal-ai/wan-i2v-lora", provider: "fal" })).status).toBe("done");
  });

  it("storyboard pictures: the check is on with and without reference pictures, and a flagged picture is a failure", async () => {
    for (const references of [undefined, ["data:image/png;base64,AA=="]]) {
      const rec = recorder(() => ({ images: [{ url: "https://v3.fal.media/x.jpg" }], has_nsfw_concepts: [false] }));
      await new FalImageProvider("k", rec.fetchImpl).generate({ prompt: "p", referenceImages: references });
      expect(rec.calls[0]!.body).toMatchObject({ enable_safety_checker: true });
    }
    const flagged = recorder(() => ({ images: [{ url: "https://v3.fal.media/black.jpg" }], has_nsfw_concepts: [true] }));
    // The error carries the model and usage, so the caller can record Fal's bill before refusing.
    await expect(new FalImageProvider("k", flagged.fetchImpl).generate({ prompt: "p" })).rejects.toBeInstanceOf(FalFlaggedError);
    await expect(new FalImageProvider("k", flagged.fetchImpl).generate({ prompt: "p" })).rejects.toMatchObject({ model: "fal-ai/flux/schnell", usage: { images: 1 } });
    const direct = recorder(() => ({ images: [{ url: "https://v3.fal.media/black.jpg" }], has_nsfw_concepts: [true] }));
    await expect(new FalDirectPictureProvider("k", direct.fetchImpl).generate({ prompt: "p" })).rejects.toThrow(/safety check flagged/);
    expect(direct.calls[0]!.body).toMatchObject({ enable_safety_checker: true });
  });
});

describe("the Media Studio plugin's Fal calls carry the same safety fields", () => {
  it("pictures, with and without reference pictures, and a flagged picture is a failure", async () => {
    for (const referenceImages of [undefined, ["data:image/png;base64,AA=="]]) {
      const rec = recorder(() => ({ images: [{ url: "https://v3.fal.media/x.jpg" }], has_nsfw_concepts: [false] }));
      await new FalProvider("k", rec.fetchImpl as never).generate({ prompt: "p", referenceImages } as never);
      expect(rec.calls[0]!.body).toMatchObject({ enable_safety_checker: true });
    }
    const flagged = recorder(() => ({ images: [{ url: "https://v3.fal.media/black.jpg" }], has_nsfw_concepts: [true] }));
    await expect(new FalProvider("k", flagged.fetchImpl as never).generate({ prompt: "p" } as never)).rejects.toBeInstanceOf(FalFlaggedError);
  });

  it("queued video: Wan gets both checks, Veo the strictest tolerance, and a flagged result fails the job", async () => {
    const wan = recorder(() => ({ request_id: "r1" }));
    await falQueueSubmit(wan.fetchImpl as never, "k", "fal-ai/wan-flf2v", { prompt: "p" });
    expect(wan.calls[0]!.body).toMatchObject({ enable_safety_checker: true, enable_output_safety_checker: true });
    const veo = recorder(() => ({ request_id: "r1" }));
    await falQueueSubmit(veo.fetchImpl as never, "k", "fal-ai/veo3.1", { prompt: "p" });
    expect(veo.calls[0]!.body).toMatchObject({ safety_tolerance: "1" });
    const flagged = recorder((url) => (url.endsWith("/status") ? { status: "COMPLETED" } : { video: { url: "https://v3.fal.media/x.mp4" }, has_nsfw_concepts: [true] }));
    expect(await falQueuePoll(flagged.fetchImpl as never, "k", { externalId: "r1", model: "fal-ai/wan-flf2v", provider: "fal" } as never, "video")).toMatchObject({ status: "failed", flagged: true });
  });
});

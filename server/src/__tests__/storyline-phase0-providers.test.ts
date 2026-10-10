import { describe, expect, it } from "vitest";
import { videoRenderDurationSeconds, videoShotVideoPrompt } from "@paperclipai/shared";
import { FalVideoProvider, SogniVideoProvider, falEndImageField, sogniVideoStep } from "../services/video-provider-clients.ts";

/**
 * Storyline Phase 0 (design 7.2): end frames mapped per model, Kling 3.0
 * lengths, camera notes in the video prompt, Kling sound off unless asked,
 * and Sogni getting our prompt as written. Stubbed HTTP only -- no paid call.
 */

const START = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString("base64")}`;
const END = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]).toString("base64")}`;

function falRecorder() {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ request_id: "req-1" }), { status: 200 });
  };
  return { bodies, fetchImpl };
}

describe("Fal end frames and sound (Phase 0)", () => {
  it("Kling 3.0 Standard: start_image_url + end_image_url, any length 3-15 s, and generate_audio:false is really sent", async () => {
    const rec = falRecorder();
    const provider = new FalVideoProvider("fal-key", rec.fetchImpl);
    await provider.start({ kind: "video", prompt: "Continuous shot", model: "fal-ai/kling-video/v3/standard/image-to-video", startImage: START, endImage: END, durationSeconds: 4 });
    const sent = rec.bodies[0]!;
    expect(sent.url).toBe("https://queue.fal.run/fal-ai/kling-video/v3/standard/image-to-video");
    expect(sent.body).toMatchObject({ prompt: "Continuous shot", start_image_url: START, end_image_url: END, duration: "4", generate_audio: false });
    expect(sent.body).not.toHaveProperty("image_url");
  });

  it("Kling 3.0 keeps sound only when asked for, and sends the cast as elements next to the end frame", async () => {
    const rec = falRecorder();
    const provider = new FalVideoProvider("fal-key", rec.fetchImpl);
    await provider.start({
      kind: "video",
      prompt: "x",
      model: "fal-ai/kling-video/v3/standard/image-to-video",
      startImage: START,
      endImage: END,
      generateAudio: true,
      characters: [{ name: "Anna", images: [START] }],
    });
    expect(rec.bodies[0]!.body).toMatchObject({ generate_audio: true, start_image_url: START, end_image_url: END });
    expect(rec.bodies[0]!.body.elements).toHaveLength(1);
  });

  it("Kling 1.6/2.1 pro use tail_image_url, Wan 2.2 end_image_url; a model without an end frame is refused, not silently ignored", async () => {
    expect(falEndImageField("fal-ai/kling-video/v2.1/pro/image-to-video")).toBe("tail_image_url");
    expect(falEndImageField("fal-ai/kling-video/v1.6/pro/image-to-video")).toBe("tail_image_url");
    expect(falEndImageField("fal-ai/wan/v2.2-a14b/image-to-video")).toBe("end_image_url");
    expect(falEndImageField("fal-ai/kling-video/o3/standard/reference-to-video")).toBe("end_image_url");
    expect(falEndImageField("fal-ai/kling-video/v1.6/standard/image-to-video")).toBeNull();

    const rec = falRecorder();
    const provider = new FalVideoProvider("fal-key", rec.fetchImpl);
    await provider.start({ kind: "video", prompt: "x", model: "fal-ai/kling-video/v2.1/pro/image-to-video", startImage: START, endImage: END, durationSeconds: 5 });
    expect(rec.bodies[0]!.body).toMatchObject({ image_url: START, tail_image_url: END });
    // Kling 2.1 makes no sound, so no audio switch is sent.
    expect(rec.bodies[0]!.body).not.toHaveProperty("generate_audio");
    await expect(
      provider.start({ kind: "video", prompt: "x", model: "fal-ai/kling-video/v1.6/standard/image-to-video", startImage: START, endImage: END }),
    ).rejects.toThrow(/cannot finish on a chosen end picture/);
    expect(rec.bodies).toHaveLength(1);
  });

  it("an ordinary Kling 3.0 shot (no end frame) also goes out with sound off", async () => {
    const rec = falRecorder();
    await new FalVideoProvider("fal-key", rec.fetchImpl).start({ kind: "video", prompt: "x", model: "fal-ai/kling-video/v3/pro/image-to-video", startImage: START, durationSeconds: 7 });
    expect(rec.bodies[0]!.body).toMatchObject({ start_image_url: START, generate_audio: false, duration: "7" });
  });
});

describe("Kling 3.0 lengths and camera notes (Phase 0)", () => {
  it("Kling 3.0 renders the written length (3-15 s), older Kling still 5/10", () => {
    expect(videoRenderDurationSeconds("fal", "fal-ai/kling-video/v3/standard/image-to-video", 4)).toBe(4);
    expect(videoRenderDurationSeconds("fal", "fal-ai/kling-video/v3/standard/image-to-video", 2)).toBe(3);
    expect(videoRenderDurationSeconds("fal", null, 4)).toBe(5);
  });

  it("camera notes reach the video prompt", () => {
    expect(videoShotVideoPrompt("Anna opens the door", "slow push-in")).toBe("Anna opens the door\n\nCamera: slow push-in");
    expect(videoShotVideoPrompt("Anna opens the door", "  ")).toBe("Anna opens the door");
    expect(videoShotVideoPrompt("Anna opens the door", null)).toBe("Anna opens the door");
  });
});

function sogniApi() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let uploads = 0;
  const apiFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/v2/image/uploadUrl")) {
      uploads += 1;
      return new Response(JSON.stringify({ data: { url: `https://bucket.s3-accelerate.amazonaws.com/up-${uploads}`, fields: { key: `k-${uploads}` } } }));
    }
    if (url.includes("/v2/image/downloadUrl")) return new Response(JSON.stringify({ data: { downloadUrl: `https://bucket.s3-accelerate.amazonaws.com/ref-${uploads}.png` } }));
    if (url.endsWith("/v1/creative-agent/workflows")) return new Response(JSON.stringify({ data: { workflow: { workflowId: "wf-1" } } }), { status: 201 });
    return new Response("{}", { status: 404 });
  };
  const startBody = () => JSON.parse(String(calls.find((c) => c.url.endsWith("/v1/creative-agent/workflows"))!.init!.body));
  return { apiFetch, startBody };
}

describe("Sogni first-and-last frame, prompt as written (Phase 0)", () => {
  const transfer = async () => new Response(null, { status: 204 });

  it("LTX-2.5: both frames uploaded, endImageIndex -2, frameRole both, skipPromptProcessing on", async () => {
    const api = sogniApi();
    await new SogniVideoProvider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: transfer }).start({
      kind: "video",
      prompt: "Continuous shot, no cut.",
      model: "ltx25-22b-int8_i2v_distilled",
      startImage: START,
      endImage: END,
      durationSeconds: 3,
      promptRewrite: false,
    });
    const body = api.startBody();
    expect(body.input.steps[0]).toEqual({
      id: "video",
      toolName: "animate_photo",
      arguments: { prompt: "Continuous shot, no cut.", duration: 3, videoModel: "ltx25", sourceImageIndex: -1, endImageIndex: -2, frameRole: "both", skipPromptProcessing: true },
    });
    expect(body.media_references).toHaveLength(2);
  });

  it("MiniMax H3 with an end frame maps to the first/last-frame model, never plain i2v; Wan 3 also gets expandPrompt:false", async () => {
    expect(sogniVideoStep("minimax-h3-fastvideo-int8_i2v_turbo", true, true).videoModel).toBe("minimax-h3-fasth3-flf2v-turbo");
    expect(sogniVideoStep("minimax-h3-fastvideo-int8_i2v_turbo", true, false).videoModel).toBe("minimax-h3-fasth3-i2v-turbo");
    const api = sogniApi();
    await new SogniVideoProvider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: transfer }).start({ kind: "video", prompt: "p", model: "wan3.0-video", startImage: START, endImage: END, promptRewrite: false });
    expect(api.startBody().input.steps[0].arguments).toMatchObject({ videoModel: "wan3.0-video", expandPrompt: false, skipPromptProcessing: true, frameRole: "both" });
  });

  it("a model that cannot take an end frame is refused before anything is sent", async () => {
    const api = sogniApi();
    await expect(
      new SogniVideoProvider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: transfer }).start({ kind: "video", prompt: "p", model: "seedance-2-0", startImage: START, endImage: END }),
    ).rejects.toThrow(/cannot finish on a chosen end picture/);
  });
});

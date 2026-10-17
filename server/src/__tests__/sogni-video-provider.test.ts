import { afterEach, describe, expect, it, vi } from "vitest";
import { SogniVideoProvider as PluginSogniVideoProvider } from "../../../packages/plugins/media-studio/src/video.js";
import {
  sanitizeSogniErrorText as pluginSanitize,
  sogniVideoModelKey as pluginModelKey,
  sogniVideoRefusal as pluginRefusal,
  sogniVideoStep as pluginVideoStep,
} from "../../../packages/plugins/media-studio/src/sogni-video-step.js";
import { guardedTransferFetch } from "../../../packages/plugins/media-studio/src/sogni.js";
import { encodeMultipartBody, sogniStorageFetch } from "../services/image-provider-clients.ts";
import { buildPinnedRequestOptions, type ValidatedFetchTarget } from "../services/safe-outbound-fetch.ts";
import { describeRenderStartFailure } from "../services/video-storyline-render.ts";
import {
  SogniVideoProvider,
  SogniVideoRequestError,
  sanitizeSogniErrorText,
  sogniVideoModelKey,
  sogniVideoRefusal,
  sogniVideoStep,
} from "../services/video-provider-clients.ts";

/**
 * Sogni video: uploads go to Sogni's storage as real multipart bytes (they
 * used to become the text "[object FormData]"), still through the pinned,
 * SSRF-guarded fetch; and the workflow step follows Sogni's published tool
 * schemas (generate_video / animate_photo, @sogni-ai/sogni-intelligence-client
 * 4.11.0). Stubbed HTTP only.
 */

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
const PNG_DATA_URI = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const PNG_DATA_URI_2 = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]).toString("base64")}`;

const TARGET: ValidatedFetchTarget = {
  parsedUrl: new URL("https://bucket.s3-accelerate.amazonaws.com/up"),
  resolvedAddress: "52.0.0.1",
  hostHeader: "bucket.s3-accelerate.amazonaws.com",
  tlsServername: "bucket.s3-accelerate.amazonaws.com",
  useTls: true,
};

describe("pinned fetch bodies", () => {
  it("sends bytes as bytes, refuses FormData instead of sending '[object FormData]', keeps URLSearchParams text", () => {
    const bytes = buildPinnedRequestOptions(TARGET, { method: "POST", body: PNG_BYTES });
    expect(Buffer.isBuffer(bytes.body)).toBe(true);
    expect(bytes.options.headers).toMatchObject({ "content-length": String(PNG_BYTES.length) });
    expect(() => buildPinnedRequestOptions(TARGET, { method: "POST", body: new FormData() })).toThrow(/encode it to bytes first/);
    expect(buildPinnedRequestOptions(TARGET, { method: "POST", body: new URLSearchParams({ a: "1" }) }).body).toBe("a=1");
  });
});

/** A stand-in for the pinned fetch that records exactly what would go on the wire. */
function recordingPinnedFetch() {
  const sent: Array<{ url: string; method: string; contentType: string | null; body: Buffer | null }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // Whatever the pinned fetch writes is what buildPinnedRequestOptions produced.
    const wire = buildPinnedRequestOptions({ ...TARGET, parsedUrl: new URL(url) }, init);
    sent.push({ url, method: init?.method ?? "GET", contentType: headers.get("content-type"), body: wire.body === undefined ? null : Buffer.from(wire.body) });
    if (init?.method === "POST") return new Response(null, { status: 204 });
    return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
  };
  return { sent, fetch };
}

describe("Sogni storage uploads", () => {
  it("encodes FormData to a multipart body that carries the picture bytes", async () => {
    const form = new FormData();
    form.append("key", "uploads/abc");
    form.append("file", new Blob([PNG_BYTES], { type: "image/png" }), "frame.png");
    const encoded = await encodeMultipartBody({ method: "POST", body: form });
    const body = encoded!.body as Buffer;
    const contentType = new Headers(encoded!.headers).get("content-type")!;
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const boundary = contentType.split("boundary=")[1]!;
    const text = body.toString("latin1");
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain('name="key"');
    expect(text).toContain('name="file"; filename="frame.png"');
    expect(body.includes(PNG_BYTES)).toBe(true);
    expect(text).not.toContain("[object FormData]");
  });

  it("only talks to Sogni's storage hosts", async () => {
    const pinned = recordingPinnedFetch();
    const storage = sogniStorageFetch(pinned.fetch);
    await expect(storage("https://evil.example.com/up", { method: "POST", body: "x" })).rejects.toThrow(/outside its own storage/);
    await expect(storage("http://media.sogni.ai/x", { method: "GET" })).rejects.toThrow();
    expect(pinned.sent).toHaveLength(0);
  });
});

function sogniApi(startAnswer?: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let uploads = 0;
  const apiFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/v2/image/uploadUrl")) {
      uploads += 1;
      return new Response(JSON.stringify({ data: { url: `https://bucket.s3-accelerate.amazonaws.com/up-${uploads}`, fields: { key: `k-${uploads}`, policy: "p" } } }));
    }
    if (url.includes("/v2/image/downloadUrl")) {
      return new Response(JSON.stringify({ data: { downloadUrl: `https://bucket.s3-accelerate.amazonaws.com/ref-${uploads}.png` } }));
    }
    if (url.endsWith("/v1/creative-agent/workflows")) {
      return startAnswer ? startAnswer() : new Response(JSON.stringify({ data: { workflow: { workflowId: "wf-9" } } }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  };
  const startBody = () => JSON.parse(String(calls.find((c) => c.url.endsWith("/v1/creative-agent/workflows"))!.init!.body));
  const uploadSlots = () => calls.filter((c) => c.url.includes("/v2/image/uploadUrl")).map((c) => new URL(c.url).searchParams.get("type"));
  return { calls, apiFetch, startBody, uploadSlots };
}

describe("SogniVideoProvider", () => {
  it("image-to-video: animate_photo with the start frame as a real multipart upload", async () => {
    const api = sogniApi();
    const pinned = recordingPinnedFetch();
    const provider = new SogniVideoProvider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: sogniStorageFetch(pinned.fetch), defaultModel: "ltx23-22b-fp8_i2v_distilled" });
    const handle = await provider.start({ kind: "video", prompt: "She turns and smiles", startImage: PNG_DATA_URI, durationSeconds: 5, seed: 7 });

    const step = api.startBody().input.steps[0];
    expect(step).toEqual({ id: "video", toolName: "animate_photo", arguments: { prompt: "She turns and smiles", duration: 5, videoModel: "ltx23", sourceImageIndex: -1 } });
    expect(api.startBody().media_references).toEqual([{ kind: "image", url: "https://bucket.s3-accelerate.amazonaws.com/ref-1.png" }]);
    expect(handle.model).toBe("ltx23");

    const upload = pinned.sent.find((s) => s.method === "POST")!;
    expect(upload.url).toBe("https://bucket.s3-accelerate.amazonaws.com/up-1");
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload.body!.includes(PNG_BYTES)).toBe(true);
    expect(upload.body!.toString("latin1")).toContain('name="key"');
    expect(upload.body!.toString("latin1")).not.toContain("[object FormData]");
  });

  it("Seedance: generate_video with the start frame and character pictures as loose references", async () => {
    const api = sogniApi();
    const pinned = recordingPinnedFetch();
    const provider = new SogniVideoProvider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: sogniStorageFetch(pinned.fetch) });
    await provider.start({ kind: "video", prompt: "Walks into the rain", model: "seedance-2-0-fast", startImage: PNG_DATA_URI, referenceImages: [PNG_DATA_URI_2], durationSeconds: 8 });
    expect(api.startBody().input.steps[0]).toEqual({
      id: "video",
      toolName: "generate_video",
      arguments: { prompt: "Walks into the rain", duration: 8, videoModel: "seedance2-mini", referenceImageIndices: [-1, -2] },
    });
    expect(api.uploadSlots()).toEqual(["contextImage1", "contextImage2"]);
    expect(pinned.sent.filter((s) => s.method === "POST")).toHaveLength(2);
  });

  it("text-to-video: no uploads, no fields the schema does not list", async () => {
    const api = sogniApi();
    const pinned = recordingPinnedFetch();
    const provider = new SogniVideoProvider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: sogniStorageFetch(pinned.fetch) });
    await provider.start({ kind: "video", prompt: "A quiet harbour", durationSeconds: 5, referenceImages: [PNG_DATA_URI] });
    const step = api.startBody().input.steps[0];
    // Sogni's default model (LTX 2.5) takes no loose references, so none are uploaded.
    expect(step).toEqual({ id: "video", toolName: "generate_video", arguments: { prompt: "A quiet harbour", duration: 5 } });
    expect(api.startBody().media_references).toBeUndefined();
    expect(pinned.sent).toHaveLength(0);
  });
});

describe("Sogni video model names", () => {
  it("maps catalogue ids from the picker to the tool keys, per job", () => {
    expect(sogniVideoModelKey(null, false)).toBeNull();
    expect(sogniVideoModelKey("ltx25-22b-int8_t2v_distilled", false)).toBe("ltx25");
    expect(sogniVideoModelKey("ltx23-22b-10eros-v1.4-fp8mixed_i2v", true)).toBe("ltx23");
    expect(sogniVideoModelKey("wan_v2.2-14b-fp8_i2v_lightx2v", true)).toBe("wan22");
    expect(sogniVideoModelKey("seedance-2-0", false)).toBe("seedance2");
    expect(sogniVideoModelKey("seedance-2-5-uncensored", false)).toBe("seedance2-5-uncensored");
    expect(sogniVideoModelKey("minimax-h3-fl2va-fp8_t2v_turbo", true)).toBe("minimax-h3-i2v-turbo");
    expect(sogniVideoModelKey("minimax-h3-fl2va-fp8_i2v", false)).toBe("minimax-h3-t2v");
    expect(sogniVideoModelKey("minimax-h3-fastvideo-int8_flf2v_turbo_2stage", true)).toBe("minimax-h3-fasth3-flf2v-turbo-2stage");
    expect(sogniVideoModelKey("minimax-h3-ref2va-fp8_r2v_balanced_2stage", false)).toBe("minimax-h3-r2v-balanced-2stage");
    expect(sogniVideoModelKey("happyhorse-1.1-t2v", true)).toBe("happyhorse-1.1-i2v");
    expect(sogniVideoModelKey("wan3.0-spicy-video", false)).toBe("wan3.0-spicy-video");
    expect(sogniVideoModelKey("my-custom-model", false)).toBe("my-custom-model");
  });

  it("picks the tool: start frame -> animate_photo, except Seedance and reference models", () => {
    expect(sogniVideoStep(null, true)).toEqual({ tool: "animate_photo", videoModel: null, pictures: "start" });
    expect(sogniVideoStep(null, false)).toEqual({ tool: "generate_video", videoModel: null, pictures: "none" });
    expect(sogniVideoStep("seedance-2-0", true)).toEqual({ tool: "generate_video", videoModel: "seedance2", pictures: "references" });
    expect(sogniVideoStep("minimax-h3-ref2va-fp8_r2v_turbo", true)).toEqual({ tool: "generate_video", videoModel: "minimax-h3-r2v-turbo", pictures: "references" });
    expect(sogniVideoStep("wan3.0-video", true)).toEqual({ tool: "animate_photo", videoModel: "wan3.0-video", pictures: "start" });
  });
});

// ─── The plugin's own client (agent "generate-video" tool) ─────────────────

const MODEL_IDS = [
  null, "ltx25", "ltx25-22b-int8_i2v_distilled", "ltx23-22b-fp8_t2v_dev", "ltx23-22b-10eros-v1.4-fp8mixed_i2v", "wan22",
  "wan_v2.2-14b-fp8_t2v_lightx2v", "wan3.0-video", "wan3.0-spicy-video", "seedance-2-0", "seedance-2-0-fast", "seedance-2-5",
  "seedance2-mini", "happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v", "minimax-h3-fl2va-fp8_t2v",
  "minimax-h3-fl2va-fp8_i2v_turbo", "minimax-h3-fastvideo-int8_t2v_turbo_2stage", "minimax-h3-fastvideo-int8_flf2v_turbo",
  "minimax-h3-ref2va-fp8_r2v", "minimax-h3-ref2va-fp8_r2v_balanced_2stage", "my-custom-model",
  "ltx25-22b-int8_t2v_distilled", "minimax-h3-i2v-balanced", "minimax-h3-fl2va-fp8_flf2v_balanced", "minimax-h3-balanced",
  "minimax-h3-ref2va-fp8_r2v_balanced", "seedance-2-0-mini-uncensored", "seedance2-mini-uncensored",
];

describe("plugin and server Sogni video clients agree", () => {
  it("same model keys and tool choice for every catalogue id", () => {
    for (const id of MODEL_IDS) {
      for (const withStart of [true, false]) {
        expect(pluginModelKey(id, withStart)).toBe(sogniVideoModelKey(id, withStart));
        expect(pluginVideoStep(id, withStart)).toEqual(sogniVideoStep(id, withStart));
      }
    }
  });

  it("same workflow request body for the same shot", async () => {
    const cases = [
      { model: "ltx23-22b-fp8_i2v_distilled", startImage: PNG_DATA_URI, durationSeconds: 5 },
      { model: "seedance-2-0-fast", startImage: PNG_DATA_URI, referenceImages: [PNG_DATA_URI_2], durationSeconds: 8 },
      { model: "minimax-h3-ref2va-fp8_r2v_turbo", referenceImages: [PNG_DATA_URI_2], durationSeconds: 6 },
      { model: undefined, durationSeconds: 5, seed: 3 },
    ];
    for (const shot of cases) {
      const serverApi = sogniApi();
      const pluginApi = sogniApi();
      const transfer = async () => new Response(null, { status: 204 });
      await new SogniVideoProvider({ apiKey: "k", apiFetch: serverApi.apiFetch, transferFetch: transfer }).start({ kind: "video", prompt: "Shot", ...shot });
      await new PluginSogniVideoProvider({ apiKey: "k", apiFetch: pluginApi.apiFetch, transferFetch: transfer }).start({ kind: "video", prompt: "Shot", ...shot });
      expect(pluginApi.startBody()).toEqual(serverApi.startBody());
      expect(pluginApi.uploadSlots()).toEqual(serverApi.uploadSlots());
      const args = pluginApi.startBody().input.steps[0].arguments;
      expect(Object.keys(args).filter((k) => ["model", "seed", "durationSeconds"].includes(k))).toEqual([]);
    }
  });
});

describe("plugin Sogni video uploads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the start frame as a real multipart upload through guardedTransferFetch", async () => {
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, init });
        return new Response(null, { status: 204 });
      }),
    );
    const api = sogniApi();
    const provider = new PluginSogniVideoProvider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: guardedTransferFetch, defaultModel: "wan22" });
    await provider.start({ kind: "video", prompt: "Pan left", startImage: PNG_DATA_URI, durationSeconds: 5 });
    expect(api.startBody().input.steps[0]).toEqual({ id: "video", toolName: "animate_photo", arguments: { prompt: "Pan left", duration: 5, videoModel: "wan22", sourceImageIndex: -1 } });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://bucket.s3-accelerate.amazonaws.com/up-1");
    expect(sent[0]!.init!.redirect).toBe("error");
    // What the platform fetch puts on the wire for this body: multipart with the picture bytes.
    const wire = new Request("https://x.invalid/", { method: "POST", body: sent[0]!.init!.body as FormData });
    expect(wire.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const bytes = Buffer.from(await wire.arrayBuffer());
    expect(bytes.includes(PNG_BYTES)).toBe(true);
    expect(bytes.toString("latin1")).toContain('name="key"');
  });

  it("refuses an upload address outside Sogni's storage", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Throws before any request (inside the provider's async upload this becomes a rejection).
    expect(() => guardedTransferFetch("https://evil.example.com/up", { method: "POST" })).toThrow(/not Sogni's picture storage/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── 17 Oct 2026: Sogni refused animate_photo with videoModel "ltx25" ──────

/** Sogni's animate_photo videoModel list as its live answer of 17 Oct 2026 started it, completed from @sogni-ai/sogni-client 5.64.0's hosted tools manifest. */
const SOGNI_ANIMATE_PHOTO_MODELS = [
  "ltx25", "ltx23", "wan22", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v", "minimax-h3-i2v", "minimax-h3-i2v-balanced",
  "minimax-h3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo", "minimax-h3-fasth3-i2v-turbo-2stage", "minimax-h3-flf2v",
  "minimax-h3-flf2v-balanced", "minimax-h3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo", "minimax-h3-fasth3-flf2v-turbo-2stage",
  "wan3.0-video", "wan3.0-spicy-video",
];
const SOGNI_GENERATE_VIDEO_MODELS = [
  "ltx25", "ltx23", "wan22", "seedance2", "seedance2-mini", "seedance2-mini-uncensored", "seedance2-5", "seedance2-5-uncensored",
  "minimax-h3-t2v", "minimax-h3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo", "minimax-h3-fasth3-t2v-turbo-2stage",
  "happyhorse-1.1-t2v", "happyhorse-1.1-i2v", "happyhorse-1.1-r2v", "minimax-h3-r2v", "minimax-h3-r2v-turbo",
  "minimax-h3-r2v-2stage", "minimax-h3-r2v-balanced-2stage", "wan3.0-video", "wan3.0-spicy-video", "minimax-h3-turbo",
  "minimax-h3-fasth3-turbo", "minimax-h3-fasth3-turbo-2stage", "minimax-h3-balanced", "minimax-h3-t2v-balanced", "minimax-h3-r2v-balanced",
];
const SOGNI_REFUSAL_17_OCT = JSON.stringify({
  status: "error",
  errorCode: 102,
  message: `Creative workflow pre-start validation failed for step 0 (video:animate_photo): Argument "videoModel" must be one of ${SOGNI_ANIMATE_PHOTO_MODELS.map((m) => JSON.stringify(m)).join(", ")}`,
});
const transferOk = async () => new Response(null, { status: 204 });

describe("Sogni video request bodies (exact)", () => {
  const cases: Array<{ name: string; input: Record<string, unknown>; step: Record<string, unknown>; refs: number; model: string }> = [
    {
      name: "the failing shot: storyline LTX 2.5 catalogue id, approved still, prompt as written",
      input: { model: "ltx25", startImage: PNG_DATA_URI, durationSeconds: 5, promptRewrite: false },
      // LTX 2.5 is Sogni's default: asked for by leaving videoModel out.
      step: { id: "video", toolName: "animate_photo", arguments: { prompt: "Shot", duration: 5, sourceImageIndex: -1, skipPromptProcessing: true } },
      refs: 1,
      model: "ltx25",
    },
    {
      name: "LTX 2.5 catalogue id, text only",
      input: { model: "ltx25-22b-int8_t2v_distilled", durationSeconds: 4 },
      step: { id: "video", toolName: "generate_video", arguments: { prompt: "Shot", duration: 4 } },
      refs: 0,
      model: "ltx25",
    },
    {
      name: "LTX 2.5 transition (start and end picture)",
      input: { model: "ltx25-22b-int8_i2v_distilled", startImage: PNG_DATA_URI, endImage: PNG_DATA_URI_2, durationSeconds: 3, promptRewrite: false },
      step: { id: "video", toolName: "animate_photo", arguments: { prompt: "Shot", duration: 3, sourceImageIndex: -1, endImageIndex: -2, frameRole: "both", skipPromptProcessing: true } },
      refs: 2,
      model: "ltx25",
    },
    {
      name: "LTX 2.3 is named",
      input: { model: "ltx23-22b-fp8_i2v_distilled", startImage: PNG_DATA_URI, durationSeconds: 5 },
      step: { id: "video", toolName: "animate_photo", arguments: { prompt: "Shot", duration: 5, videoModel: "ltx23", sourceImageIndex: -1 } },
      refs: 1,
      model: "ltx23",
    },
    {
      name: "MiniMax H3 Balanced keeps its own key",
      input: { model: "minimax-h3-fl2va-fp8_i2v_balanced", startImage: PNG_DATA_URI, durationSeconds: 6 },
      step: { id: "video", toolName: "animate_photo", arguments: { prompt: "Shot", duration: 6, videoModel: "minimax-h3-i2v-balanced", sourceImageIndex: -1 } },
      refs: 1,
      model: "minimax-h3-i2v-balanced",
    },
    {
      name: "Seedance 2.0 Mini Uncensored: loose references",
      input: { model: "seedance-2-0-mini-uncensored", startImage: PNG_DATA_URI, referenceImages: [PNG_DATA_URI_2], durationSeconds: 8 },
      step: { id: "video", toolName: "generate_video", arguments: { prompt: "Shot", duration: 8, videoModel: "seedance2-mini-uncensored", referenceImageIndices: [-1, -2] } },
      refs: 2,
      model: "seedance2-mini-uncensored",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      for (const Provider of [SogniVideoProvider, PluginSogniVideoProvider]) {
        const api = sogniApi();
        const handle = await new Provider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: transferOk }).start({ kind: "video", prompt: "Shot", ...c.input });
        const body = api.startBody();
        expect(body.input.steps).toEqual([c.step]);
        expect(body.media_references ?? []).toHaveLength(c.refs);
        expect(body).toMatchObject({ token_type: "auto", app_source: "paperclip-media-studio", safe_content_filter: true });
        expect(handle.model).toBe(c.model);
      }
    });
  }

  it("every key we send is on Sogni's current list for that tool", () => {
    for (const id of MODEL_IDS) {
      for (const [start, end] of [[true, false], [true, true], [false, false]] as const) {
        const plan = sogniVideoStep(id, start, end);
        if (!plan.videoModel || plan.videoModel === "my-custom-model") continue;
        const list = plan.tool === "animate_photo" ? SOGNI_ANIMATE_PHOTO_MODELS : SOGNI_GENERATE_VIDEO_MODELS;
        expect(list, `${id} (${plan.tool})`).toContain(plan.videoModel);
      }
    }
  });
});

describe("Sogni refusals are readable", () => {
  it("the 17 Oct refusal: says which model, for what, what Sogni accepts, and keeps Sogni's whole message", async () => {
    for (const Provider of [SogniVideoProvider, PluginSogniVideoProvider]) {
      const api = sogniApi(() => new Response(SOGNI_REFUSAL_17_OCT, { status: 400, headers: { "content-type": "application/json" } }));
      const err = await new Provider({ apiKey: "k", apiFetch: api.apiFetch, transferFetch: transferOk })
        .start({ kind: "video", prompt: "Shot", model: "ltx25", startImage: PNG_DATA_URI, durationSeconds: 5, promptRewrite: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const e = err as SogniVideoRequestError;
      expect(e.message).toMatch(/^Sogni refused the video request \(400\): it didn't accept the video model "ltx25" \(asked for as Sogni's default, without naming it\) for animating a picture; it accepts: ltx25, ltx23, wan22, /);
      expect(e.message).toContain("minimax-h3-fasth3-flf2v-turbo-2stage, wan3.0-video, wan3.0-spicy-video.");
      expect(e.message).toContain(`"ltx25" is on Sogni's own list, so this looks like a problem on Sogni's side.`);
      // Sogni's own words, whole (the old code cut them at 300 characters, mid-list).
      expect(e.message).toContain('Sogni said: Creative workflow pre-start validation failed for step 0 (video:animate_photo): Argument "videoModel" must be one of "ltx25"');
      expect(e.message).toContain('"wan3.0-spicy-video"');
      expect(e).toMatchObject({ status: 400, sogniErrorCode: 102, tool: "animate_photo", videoModel: "ltx25", sentVideoModel: null });
    }
  });

  it("a model Sogni does not list: names it and the list, no 'Sogni's side' hint", () => {
    const body = JSON.stringify({ status: "error", errorCode: 102, message: 'Creative workflow pre-start validation failed for step 0 (video:animate_photo): Argument "videoModel" must be one of "ltx25", "ltx23"' });
    for (const refusal of [sogniVideoRefusal, pluginRefusal]) {
      const e = refusal(400, body, { tool: "animate_photo", videoModel: "my-custom-model", sentVideoModel: "my-custom-model" });
      expect(e.message).toBe(
        `Sogni refused the video request (400): it didn't accept the video model "my-custom-model" for animating a picture; it accepts: ltx25, ltx23. Sogni said: Creative workflow pre-start validation failed for step 0 (video:animate_photo): Argument "videoModel" must be one of "ltx25", "ltx23"`,
      );
    }
  });

  it("any other refusal: what we asked for plus Sogni's reason; plain text bodies too", () => {
    const json = sogniVideoRefusal(400, JSON.stringify({ status: "error", errorCode: 7, message: "Prompt too long." }), { tool: "generate_video", videoModel: "seedance2", sentVideoModel: "seedance2" });
    expect(json.message).toBe(`Sogni refused the video request (400) for making a video with the video model "seedance2": Prompt too long.`);
    expect(json.sogniErrorCode).toBe(7);
    const text = sogniVideoRefusal(503, "Service Unavailable", { tool: "animate_photo", videoModel: null, sentVideoModel: null });
    expect(text.message).toBe(`Sogni refused the video request (503) for animating a picture with Sogni's default video model: Service Unavailable`);
    expect(sogniVideoRefusal(400, "", { tool: "animate_photo", videoModel: null, sentVideoModel: null }).message).toMatch(/no reason given$/);
  });

  it("never carries links, keys or picture data, and stops at about 1500 characters", () => {
    const apiKey = "sk-live-0123456789abcdef";
    const raw = [
      `Upload https://bucket.s3-accelerate.amazonaws.com/up-1?X-Amz-Signature=abc failed;`,
      `key ${apiKey}; header Bearer abc.def.ghi;`,
      `image ${PNG_DATA_URI};`,
      `token ${"A".repeat(64)};`,
      "x ".repeat(2000),
    ].join(" ");
    for (const clean of [sanitizeSogniErrorText, pluginSanitize]) {
      const out = clean(raw, [apiKey]);
      expect(out).not.toMatch(/https?:\/\//);
      expect(out).not.toContain(apiKey);
      expect(out).not.toContain("abc.def.ghi");
      expect(out).not.toContain("base64");
      expect(out).not.toContain("A".repeat(40));
      expect(out).toContain("[link]");
      expect(out.length).toBeLessThanOrEqual(1500);
    }
    const e = sogniVideoRefusal(400, JSON.stringify({ message: raw }), { tool: "animate_photo", videoModel: "ltx23", sentVideoModel: "ltx23" }, [apiKey]);
    expect(e.message).not.toContain(apiKey);
    expect(e.sogniMessage.length).toBeLessThanOrEqual(1500);
  });

  it("the storyline shows Sogni's whole reason, not 300 characters of it", () => {
    const e = sogniVideoRefusal(400, SOGNI_REFUSAL_17_OCT, { tool: "animate_photo", videoModel: "ltx25", sentVideoModel: null });
    const shown = describeRenderStartFailure(e, { providerId: "sogni", shotNumber: 1, charged: false });
    expect(shown.startsWith("Sogni didn't accept shot 1: Sogni refused the video request (400): it didn't accept the video model \"ltx25\"")).toBe(true);
    expect(shown).toContain('"wan3.0-spicy-video"');
    expect(shown).toContain("Nothing was charged.");
  });
});

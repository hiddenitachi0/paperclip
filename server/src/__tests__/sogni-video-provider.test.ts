import { describe, expect, it } from "vitest";
import { encodeMultipartBody, sogniStorageFetch } from "../services/image-provider-clients.ts";
import { buildPinnedRequestOptions, type ValidatedFetchTarget } from "../services/safe-outbound-fetch.ts";
import { SogniVideoProvider, sogniVideoModelKey, sogniVideoStep } from "../services/video-provider-clients.ts";

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

function sogniApi() {
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
    if (url.endsWith("/v1/creative-agent/workflows")) return new Response(JSON.stringify({ data: { workflow: { workflowId: "wf-9" } } }), { status: 201 });
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

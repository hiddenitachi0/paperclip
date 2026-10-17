import { describe, expect, it } from "vitest";
import { unprocessable } from "../errors.ts";
import { sogniStorageFetch } from "../services/image-provider-clients.ts";
import { pinnedToFetchResponse, type PinnedHttpResponse } from "../services/safe-outbound-fetch.ts";
import { SogniVideoProvider } from "../services/video-provider-clients.ts";
import { describeRenderStartFailure } from "../services/video-storyline-render.ts";

/**
 * 17 Oct production bug: "Response constructor: Invalid response status code
 * 204". Sogni's storage answers a picture upload with 204 No Content; the
 * render's safeFetch rebuilt every pinned answer as `new Response(bytes,
 * {status})`, which throws for a null-body status, so every Sogni render
 * that sent a start picture crashed (and left the storyline stuck on
 * "rendering"). These tests go through the real rebuild
 * (pinnedToFetchResponse) instead of a fake that hands back a ready-made
 * Response -- which is how the old tests missed it. No real Sogni calls.
 */

function pinned(status: number, body = "", headers: Record<string, string> = {}): PinnedHttpResponse {
  const bytes = Buffer.from(body);
  return { status, statusText: "", headers, body, bodyBytes: bytes };
}

describe("pinnedToFetchResponse", () => {
  it("rebuilds null-body statuses without a body instead of throwing", async () => {
    for (const status of [204, 205, 304]) {
      const res = pinnedToFetchResponse(pinned(status));
      expect(res.status).toBe(status);
      expect(await res.text()).toBe("");
    }
    // The old rebuild is exactly what crashed in production.
    expect(() => new Response(new Uint8Array(0), { status: 204 })).toThrow(/204/);
  });

  it("keeps ordinary bodies byte for byte, and turns impossible statuses into 502", async () => {
    const ok = pinnedToFetchResponse(pinned(200, "{\"a\":1}", { "content-type": "application/json" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json");
    expect(await ok.json()).toEqual({ a: 1 });
    for (const status of [0, 101, 103, 600]) {
      const res = pinnedToFetchResponse(pinned(status, "x"));
      expect(res.status).toBe(502);
      expect(res.ok).toBe(false);
    }
  });
});

describe("SogniVideoProvider start picture upload answered with 204", () => {
  it("uploads the start picture and starts the job", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const calls: string[] = [];
    // Every answer goes through the same rebuild the production safeFetch uses.
    const apiFetch = async (url: string) => {
      calls.push(url);
      if (url.includes("/v2/image/uploadUrl")) return pinnedToFetchResponse(pinned(200, JSON.stringify({ data: { url: "https://bucket.s3-accelerate.amazonaws.com/up", fields: { key: "k" } } })));
      if (url.includes("/v2/image/downloadUrl")) return pinnedToFetchResponse(pinned(200, JSON.stringify({ data: { downloadUrl: "https://bucket.s3-accelerate.amazonaws.com/ref.png" } })));
      if (url.endsWith("/v1/creative-agent/workflows")) return pinnedToFetchResponse(pinned(201, JSON.stringify({ data: { workflow: { workflowId: "wf-1" } } })));
      return pinnedToFetchResponse(pinned(404, "{}"));
    };
    const storagePinned = async (url: string) => {
      calls.push(`storage:${url}`);
      return pinnedToFetchResponse(pinned(204));
    };
    const provider = new SogniVideoProvider({ apiKey: "k", apiFetch, transferFetch: sogniStorageFetch(storagePinned), defaultModel: "ltx23-22b-fp8_i2v_distilled" });
    const handle = await provider.start({ kind: "video", prompt: "She smiles", startImage: `data:image/png;base64,${png.toString("base64")}`, durationSeconds: 5 });
    expect(handle.externalId).toBe("wf-1");
    expect(calls).toContain("storage:https://bucket.s3-accelerate.amazonaws.com/up");
  });
});

describe("describeRenderStartFailure", () => {
  const sogni = { providerId: "sogni" as const, shotNumber: 1 };

  it("passes our own plain refusals through unchanged", () => {
    expect(describeRenderStartFailure(unprocessable("No Sogni API key is set for this company yet."), sogni)).toBe("No Sogni API key is set for this company yet.");
  });

  it("says what the video service refused, that nothing was charged, and what to do", () => {
    const text = describeRenderStartFailure(new Error("Sogni's storage did not take the starting frame (403)."), sogni);
    expect(text).toContain("didn't accept the API key");
    const upload = describeRenderStartFailure(new Error("Sogni did not give a place to upload the starting frame (500)."), sogni);
    expect(upload).toBe("Sogni didn't accept shot 1: Sogni did not give a place to upload the starting frame (500). Nothing was charged. Try again in a minute.");
    expect(describeRenderStartFailure(new Error("Sogni refused the video request (402): no credit"), sogni)).toContain("enough credit");
  });

  it("never shows a programming error's raw text (the 204 crash), but says it is on our side", () => {
    const text = describeRenderStartFailure(new TypeError("Response constructor: Invalid response status code 204"), { providerId: "sogni", shotNumber: 3 });
    expect(text).not.toContain("Response constructor");
    expect(text).toContain("Something went wrong on our side while sending shot 3 to Sogni");
    expect(text).toContain("Nothing was charged");
  });

  it("explains timeouts and unreachable services, and warns when a job may have started", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(describeRenderStartFailure(abort, sogni)).toContain("didn't answer in time");
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(describeRenderStartFailure(refused, { providerId: "fal", shotNumber: 2 })).toContain("Couldn't reach Fal.ai");
    expect(describeRenderStartFailure(new Error("db down"), { ...sogni, charged: true })).toContain("check its dashboard before trying again");
  });
});

describe("clipTrimInputArgs (a made AI clip's trim when combining)", () => {
  it("seeks and limits with clamped numbers only", async () => {
    const { clipTrimInputArgs } = await import("../services/video-ffmpeg.ts");
    expect(clipTrimInputArgs(undefined)).toEqual([]);
    expect(clipTrimInputArgs({ startMs: 1_000, endMs: 4_000 })).toEqual(["-ss", "1.000", "-t", "3.000"]);
    expect(clipTrimInputArgs({ startMs: 0, endMs: 2_500 })).toEqual(["-t", "2.500"]);
    expect(clipTrimInputArgs({ startMs: 1_500, endMs: null })).toEqual(["-ss", "1.500"]);
    expect(clipTrimInputArgs({ startMs: -5, endMs: Number.NaN })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { FAL_STORE_IO_HEADER, FalVideoProvider } from "../services/video-provider-clients.ts";

/**
 * Storyline Phase 2 (design 2.5): a Fal request carrying the company's own
 * footage is sent with `X-Fal-Store-IO: 0`, and the normal poll/result path
 * still delivers the clip. A stub stands in for Fal -- the live behaviour of
 * the queue's result endpoint with storage off is NOT proven here (see the
 * risk note in the PR / report): Fal documents that CDN files stay reachable,
 * but says nothing about the queue response payload.
 */

function stubFal() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    if (init?.method === "POST") return new Response(JSON.stringify({ request_id: "req-1" }));
    if (url.endsWith("/status")) return new Response(JSON.stringify({ status: "COMPLETED" }));
    return new Response(JSON.stringify({ video: { url: "https://v3.fal.media/files/out.mp4", content_type: "video/mp4" } }));
  };
  return { calls, fetchImpl };
}

describe("Fal no-store for company footage", () => {
  it("sends X-Fal-Store-IO: 0 when the request carries footage, and the result still comes back", async () => {
    const fal = stubFal();
    const provider = new FalVideoProvider("key", fal.fetchImpl);
    const handle = await provider.start({ kind: "video", prompt: "p", model: "fal-ai/kling-video/v3/standard/image-to-video", startImage: "data:image/jpeg;base64,AA==", storeIO: false });
    expect(fal.calls[0]!.headers[FAL_STORE_IO_HEADER]).toBe("0");
    expect(fal.calls[0]!.headers.Authorization).toBe("Key key");
    const outcome = await provider.poll(handle);
    expect(outcome).toMatchObject({ status: "done", result: { url: "https://v3.fal.media/files/out.mp4" } });
  });

  it("leaves the header off for AI-only requests", async () => {
    const fal = stubFal();
    await new FalVideoProvider("key", fal.fetchImpl).start({ kind: "video", prompt: "p", model: "fal-ai/kling-video/v3/standard/image-to-video", startImage: "data:image/jpeg;base64,AA==" });
    expect(fal.calls[0]!.headers[FAL_STORE_IO_HEADER]).toBeUndefined();
  });

  it("a missing result with storage off is a plain failure, never a silent success", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (init?.method === "POST") return new Response(JSON.stringify({ request_id: "req-2" }));
      if (url.endsWith("/status")) return new Response(JSON.stringify({ status: "COMPLETED" }));
      return new Response(JSON.stringify({}));
    };
    const provider = new FalVideoProvider("key", fetchImpl);
    const handle = await provider.start({ kind: "video", prompt: "p", model: "fal-ai/kling-video/v3/standard/image-to-video", storeIO: false });
    expect(await provider.poll(handle)).toMatchObject({ status: "failed" });
  });
});

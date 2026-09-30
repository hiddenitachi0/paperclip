// DUR-4062: Fal's async queue API (docs.fal.ai/model-endpoints/queue),
// shared by the video and audio providers. Unlike fal.run's synchronous
// picture endpoint (providers.ts FalProvider), a video or music job is
// started and polled across many separate calls, because it can take minutes
// — far past what one tool call may block for.
//
// Contract:
//   Submit  POST https://queue.fal.run/{model}                 body: the model's own input
//           -> {request_id, status_url, response_url}
//   Status  GET  {status_url}  (queue.fal.run/{model}/requests/{id}/status)
//           -> {status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED", queue_position?}
//   Result  GET  {response_url} (queue.fal.run/{model}/requests/{id})
//           -> the model's own output, e.g. {video:{url,content_type}} or {audio:{url,content_type}}
//   Cancel  PUT  https://queue.fal.run/{model}/requests/{id}/cancel

import type { FetchImpl } from "./providers.js";
import { assertFalModelId } from "./providers.js";
import type { MediaJobHandle, MediaPollOutcome } from "./media-jobs-types.js";

export const FAL_QUEUE_BASE = "https://queue.fal.run";

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}`, "Content-Type": "application/json" };
}

export async function falQueueSubmit(
  fetchImpl: FetchImpl,
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
): Promise<{ requestId: string }> {
  const checked = assertFalModelId(model);
  const res = await fetchImpl(`${FAL_QUEUE_BASE}/${checked}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fal.ai ${checked} could not be started (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) throw new Error("fal.ai did not say which job it started.");
  return { requestId: data.request_id };
}

/** A queue job's Fal status, translated to Media Studio's own poll outcome. `resultKey` is the output field ("video" or "audio"). */
export async function falQueuePoll(
  fetchImpl: FetchImpl,
  apiKey: string,
  handle: MediaJobHandle,
  resultKey: "video" | "audio",
): Promise<MediaPollOutcome> {
  const model = assertFalModelId(handle.model);
  const statusRes = await fetchImpl(`${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(handle.externalId)}/status`, {
    headers: authHeaders(apiKey),
  });
  if (!statusRes.ok) {
    if (statusRes.status >= 500) return { status: "running" }; // Fal's own retry guidance; not a lost job.
    return { status: "failed", error: `fal.ai lost track of this job (${statusRes.status}). Try again.` };
  }
  const statusBody = (await statusRes.json()) as { status?: string; queue_position?: number };
  const state = statusBody.status ?? "";
  if (state === "IN_QUEUE") {
    const position = typeof statusBody.queue_position === "number" ? statusBody.queue_position : null;
    return { status: "running", progress: position !== null ? `queued, position ${position}` : "queued" };
  }
  if (state === "IN_PROGRESS") return { status: "running", progress: "running" };
  if (state !== "COMPLETED") return { status: "failed", error: `fal.ai could not make this (status: ${state || "unknown"}).` };

  const resultRes = await fetchImpl(`${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(handle.externalId)}`, {
    headers: authHeaders(apiKey),
  });
  if (!resultRes.ok) return { status: "failed", error: `fal.ai finished but the result could not be fetched (${resultRes.status}).` };
  const result = (await resultRes.json()) as Record<string, unknown>;
  const media = result[resultKey] as { url?: string; content_type?: string } | undefined;
  if (!media?.url) return { status: "failed", error: "fal.ai finished but sent nothing back. Try again." };
  if (!/^https:\/\//i.test(media.url)) return { status: "failed", error: "fal.ai gave an address that is not https, so it was not used." };
  return {
    status: "done",
    result: {
      contentType: media.content_type ?? (resultKey === "video" ? "video/mp4" : "audio/mpeg"),
      url: media.url,
      meta: { requestId: handle.externalId },
    },
  };
}

export async function falQueueCancel(fetchImpl: FetchImpl, apiKey: string, handle: MediaJobHandle): Promise<void> {
  try {
    const model = assertFalModelId(handle.model);
    await fetchImpl(`${FAL_QUEUE_BASE}/${model}/requests/${encodeURIComponent(handle.externalId)}/cancel`, {
      method: "PUT",
      headers: authHeaders(apiKey),
    });
  } catch {
    // Best effort: the original problem is what the caller needs to hear about.
  }
}

import { describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../../../packages/plugins/media-studio/src/worker.js";
import manifest, {
  TOOL_CHECK_MEDIA_JOB,
  TOOL_GENERATE_AUDIO,
  TOOL_GENERATE_VIDEO,
} from "../../../packages/plugins/media-studio/src/manifest.js";
import { JOB_KEY_MEDIA_POLL, MEDIA_JOB_MAX_AGE_MS } from "../../../packages/plugins/media-studio/src/media-jobs.js";

/**
 * DUR-4062: generate-video / generate-audio start a background job and
 * return right away (never a blocking wait — video/audio generation can take
 * minutes, well past the tool-call timeout); the media-generation-poll
 * scheduled job (jobs.schedule) advances them and delivers the finished
 * file. Fal's queue API and the company's issue/files host calls are faked;
 * nothing real is called.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "99999999-9999-4999-8999-999999999999";
const RUN = "44444444-4444-4444-8444-444444444444";
const ISSUE = "55555555-5555-4555-8555-555555555555";
const REF_A = "66666666-6666-4666-8666-666666666666";

const runCtx = { agentId: AGENT, runId: RUN, companyId: COMPANY, projectId: "" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function companyFile(id: string, contentType = "image/png") {
  const contentPath = `/api/attachments/${id}/content`;
  return {
    id,
    companyId: COMPANY,
    issueId: null,
    contentType,
    byteSize: PNG.length,
    originalFilename: "frame.png",
    createdByAgentId: null,
    contentPath,
    openPath: contentPath,
    downloadPath: `${contentPath}?download=1`,
    createdAt: new Date(),
    contentBase64: PNG.toString("base64"),
  };
}

async function setup(config: Record<string, unknown>, withIssue = false): Promise<TestHarness> {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    companyFiles: [companyFile(REF_A)],
    agents: [{ id: AGENT, companyId: COMPANY, name: "Maja", title: null, status: "idle" } as never],
    ...(withIssue
      ? {
          issues: [
            {
              id: ISSUE,
              companyId: COMPANY,
              title: "Make a launch video",
              status: "in_progress",
              priority: "medium",
              assigneeAgentId: AGENT,
            } as never,
          ],
        }
      : {}),
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };

/** Fal's queue API (fal-queue.ts): submit, status, result, plus the result media's own URL. */
function fakeFalQueue(
  harness: TestHarness,
  opts: {
    status?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
    resultKey?: "video" | "audio";
    mediaContentType?: string;
    submitFails?: boolean;
    mediaBytes?: Buffer;
    mediaContentTypeHeader?: string;
  } = {},
) {
  const calls: Call[] = [];
  const mediaUrl = "https://cdn.fal.media/files/generated.out";
  harness.ctx.http.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    if (method === "POST" && url.startsWith("https://queue.fal.run/") && !url.includes("/requests/")) {
      if (opts.submitFails) return new Response("busy", { status: 500 });
      return json(200, { request_id: "req-1" });
    }
    if (url.endsWith("/status")) {
      return json(200, { status: opts.status ?? "COMPLETED", queue_position: 3 });
    }
    if (url.startsWith("https://queue.fal.run/") && url.includes("/requests/")) {
      const key = opts.resultKey ?? "video";
      return json(200, { [key]: { url: mediaUrl, content_type: opts.mediaContentType ?? (key === "video" ? "video/mp4" : "audio/mpeg") } });
    }
    if (url === mediaUrl) {
      return new Response(opts.mediaBytes ?? MP4, {
        status: 200,
        headers: { "Content-Type": opts.mediaContentTypeHeader ?? opts.mediaContentType ?? "video/mp4" },
      });
    }
    return json(404, { error: `unexpected ${method} ${url}` });
  }) as typeof harness.ctx.http.fetch;
  return { calls, mediaUrl };
}

const falSubmits = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("/requests/"));

const FAL = { provider: "fal", falKeySecretRef: "fal-key-ref" };

describe("generate-video", () => {
  it("starts a Fal text-to-video job and returns right away with a job id, not the finished video", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeFalQueue(harness);

    const result = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "a drone shot over a beach" }, runCtx);

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ status: "started", provider: "fal", issueId: null });
    expect(typeof result.data.jobId).toBe("string");
    expect(result.content).toMatch(/Started making the video with Fal\.ai/);
    expect(result.content).toContain("Job id:");
    const [submit] = falSubmits(calls);
    expect(submit!.body).toMatchObject({ prompt: "a drone shot over a beach" });
    // Nothing was delivered yet: no company file, no attachment.
    expect(await harness.ctx.files.get(result.data.jobId, COMPANY)).toBeNull();
  });

  it("passes the starting frame as image_url for image-to-video / continue-from-last-frame", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeFalQueue(harness);

    const result = await harness.executeTool<any>(
      TOOL_GENERATE_VIDEO,
      { prompt: "the same scene, now the sun sets", startImageFileId: REF_A },
      runCtx,
    );

    expect(result.error).toBeUndefined();
    const [submit] = falSubmits(calls);
    expect(submit!.body!.image_url).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses a starting frame that is not this company's file", async () => {
    const harness = await setup(FAL);
    fakeFalQueue(harness);
    const result = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "x", startImageFileId: "nope" }, runCtx);
    expect(result.error).toMatch(/not in this company's Files/);
  });

  it("refuses an unknown provider before calling anything", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeFalQueue(harness);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration");
    const result = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "x", provider: "comfyui" }, runCtx);
    expect(result.error).toMatch(/not a video service/);
    expect(reserve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("counts toward the daily picture limit, reserved before the provider is called", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeFalQueue(harness);
    const reserve = vi.spyOn(harness.ctx.personas, "reserveDailyGeneration").mockResolvedValueOnce({ allowed: false, cap: 3, usedToday: 3 });

    const result = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "x" }, runCtx);

    expect(result.error).toBe("Daily image limit (3) reached for this agent today.");
    expect(reserve).toHaveBeenCalledWith(COMPANY, { runId: RUN });
    expect(falSubmits(calls)).toHaveLength(0);
  });
});

describe("generate-audio", () => {
  it("starts a Fal music job with mode=music by default", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeFalQueue(harness, { resultKey: "audio" });

    const result = await harness.executeTool<any>(TOOL_GENERATE_AUDIO, { prompt: "an upbeat synthwave loop" }, runCtx);

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ status: "started", provider: "fal", mode: "music" });
    const [submit] = falSubmits(calls);
    expect(submit!.body).toMatchObject({ prompt: "an upbeat synthwave loop" });
  });

  it("starts a text-to-speech job with mode=speech and a voice", async () => {
    const harness = await setup(FAL);
    const { calls } = fakeFalQueue(harness, { resultKey: "audio" });

    const result = await harness.executeTool<any>(
      TOOL_GENERATE_AUDIO,
      { prompt: "Good morning, team.", mode: "speech", voice: "warm-female-1" },
      runCtx,
    );

    expect(result.error).toBeUndefined();
    expect(result.data.mode).toBe("speech");
    const [submit] = falSubmits(calls);
    expect(submit!.body).toMatchObject({ text: "Good morning, team.", voice: "warm-female-1" });
  });

  it("refuses an unknown mode", async () => {
    const harness = await setup(FAL);
    const result = await harness.executeTool<any>(TOOL_GENERATE_AUDIO, { prompt: "x", mode: "yodel" }, runCtx);
    expect(result.error).toMatch(/not "music" or "speech"/);
  });
});

describe("media-generation-poll (background job engine)", () => {
  it("delivers a finished video to the company's Files and comments on the task, when one was given", async () => {
    const harness = await setup(FAL, true);
    const { calls } = fakeFalQueue(harness, { status: "COMPLETED" });
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");
    const requestWakeup = vi.spyOn(harness.ctx.issues, "requestWakeup");

    const started = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "office tour", issueId: ISSUE }, runCtx);
    expect(started.error).toBeUndefined();

    await harness.runJob(JOB_KEY_MEDIA_POLL);

    const check = await harness.executeTool<any>(TOOL_CHECK_MEDIA_JOB, { jobId: started.data.jobId }, runCtx);
    expect(check.data).toMatchObject({ status: "done" });
    expect(typeof check.data.fileId).toBe("string");
    const file = await harness.ctx.files.get(check.data.fileId, COMPANY);
    expect(file).toMatchObject({ contentType: "video/mp4" });

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0]![0]).toBe(ISSUE);
    expect(String(createComment.mock.calls[0]![1])).toMatch(/video is ready/);
    expect(requestWakeup).toHaveBeenCalledWith(ISSUE, COMPANY, { reason: "media-job-complete", actorAgentId: AGENT });
    // The queue was polled (status, then result), not just submitted once.
    expect(calls.some((c) => c.url.endsWith("/status"))).toBe(true);
  });

  it("delivers to the company's Files with no comment when the job had no task", async () => {
    const harness = await setup(FAL, false);
    fakeFalQueue(harness, { status: "COMPLETED" });
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");

    const started = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "office tour" }, runCtx);
    await harness.runJob(JOB_KEY_MEDIA_POLL);

    const check = await harness.executeTool<any>(TOOL_CHECK_MEDIA_JOB, { jobId: started.data.jobId }, runCtx);
    expect(check.data.status).toBe("done");
    expect(createComment).not.toHaveBeenCalled();
  });

  it("keeps a job running (with progress) across ticks until Fal reports COMPLETED", async () => {
    const harness = await setup(FAL, false);
    fakeFalQueue(harness, { status: "IN_QUEUE" });

    const started = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "x" }, runCtx);
    await harness.runJob(JOB_KEY_MEDIA_POLL);

    const check = await harness.executeTool<any>(TOOL_CHECK_MEDIA_JOB, { jobId: started.data.jobId }, runCtx);
    expect(check.data).toMatchObject({ status: "running" });
    expect(check.data.progress).toMatch(/queued/);
  });

  it("reports a plain failure and comments it, when Fal cannot make the video", async () => {
    const harness = await setup(FAL, true);
    fakeFalQueue(harness, { status: "COMPLETED", mediaContentType: "text/html" }); // a misbehaving provider

    const started = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "x", issueId: ISSUE }, runCtx);
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");
    await harness.runJob(JOB_KEY_MEDIA_POLL);

    const check = await harness.executeTool<any>(TOOL_CHECK_MEDIA_JOB, { jobId: started.data.jobId }, runCtx);
    expect(check.data.status).toBe("failed");
    expect(check.data.error).toMatch(/not video/);
    expect(createComment.mock.calls[0]![1]).toMatch(/Could not make the video/);
  });

  it("gives up a job that has run past the maximum age, without hanging forever", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const harness = await setup(FAL, false);
    fakeFalQueue(harness, { status: "IN_QUEUE" });

    const started = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "x" }, runCtx);
    vi.advanceTimersByTime(MEDIA_JOB_MAX_AGE_MS + 1_000);
    await harness.runJob(JOB_KEY_MEDIA_POLL);

    const check = await harness.executeTool<any>(TOOL_CHECK_MEDIA_JOB, { jobId: started.data.jobId }, runCtx);
    expect(check.data.status).toBe("failed");
    expect(check.data.error).toMatch(/Gave up after/);
    vi.useRealTimers();
  });

  it("does not let one agent read another agent's job", async () => {
    const harness = await setup(FAL, false);
    fakeFalQueue(harness);
    const started = await harness.executeTool<any>(TOOL_GENERATE_VIDEO, { prompt: "x" }, runCtx);
    const otherRunCtx = { ...runCtx, agentId: OTHER_AGENT };
    const check = await harness.executeTool<any>(TOOL_CHECK_MEDIA_JOB, { jobId: started.data.jobId }, otherRunCtx);
    expect(check.error).toMatch(/No such job/);
  });
});

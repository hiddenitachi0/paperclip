// Paperclip render worker: the job queue. Jobs live in memory only; a
// restart forgets them (Paperclip then sees "unknown job" and marks its own
// record failed, so nothing is left waiting forever). Each job owns one
// directory under the jobs dir:
//
//   <jobsDir>/<id>/project/   the composition, written by us, never unpacked
//   <jobsDir>/<id>/home/      HOME and caches for the job's children
//   <jobsDir>/<id>/out/       what the job made (video.mp4, snapshots/)
//
// The directory is removed when the job is cancelled, and a finished job's
// directory is removed once Paperclip has had `resultTtlMs` to fetch it.

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CompositionError, DURATION_SLACK_SECONDS, assertCompositionLength, prepareCompositionFiles, validateComposition } from "./composition.mjs";
import {
  QUALITIES,
  buildCheckArgs,
  buildProbeArgs,
  buildRenderArgs,
  buildSnapshotArgs,
  childEnv,
  parseCheckReport,
  parseProbe,
  pickSnapshotOutput,
  runProcess,
  tail,
} from "./hyperframes.mjs";

export const JOB_KINDS = Object.freeze(["check", "snapshot", "render"]);

export class QueueFullError extends Error {
  constructor() {
    super("The renderer is busy: too many jobs are waiting. Try again in a few minutes.");
    this.name = "QueueFullError";
  }
}

/** A job that ran and failed for a reason worth showing to a person. */
export class JobFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "JobFailure";
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Job options, clamped to what this worker allows. Unknown keys are dropped. */
export function normalizeOptions(kind, raw, config) {
  const options = raw && typeof raw === "object" ? raw : {};
  return {
    fps: clampInt(options.fps, 1, 60, 30),
    quality: QUALITIES.includes(options.quality) ? options.quality : "standard",
    frames: clampInt(options.frames, 1, 24, 9),
    maxDurationSeconds: clampInt(options.maxDurationSeconds, 1, config.maxDurationSeconds, config.maxDurationSeconds),
  };
}

/**
 * How long one job may hold the renderer (D7: no job runs unbounded). A
 * check or contact sheet gets its own short budget; a render gets a start-up
 * allowance plus a multiple of the length it asked for (per second of video
 * at 30 fps; more frames per second get proportionally more time). Never
 * above the worker-wide job limit.
 */
export function jobTimeoutMs(kind, options, config) {
  const ceiling = config.jobTimeoutMs;
  if (kind === "check") return Math.min(ceiling, config.checkTimeoutMs ?? ceiling);
  if (kind === "snapshot") return Math.min(ceiling, config.snapshotTimeoutMs ?? ceiling);
  if (config.renderBaseTimeoutMs === undefined || config.renderTimeoutPerVideoSecond === undefined) return ceiling;
  const frameRateFactor = Math.max(1, (options.fps ?? 30) / 30);
  const perVideoSecondMs = config.renderTimeoutPerVideoSecond * frameRateFactor * 1000;
  return Math.min(ceiling, Math.round(config.renderBaseTimeoutMs + options.maxDurationSeconds * perVideoSecondMs));
}

/**
 * Runs one job's Hyperframes command(s). Returns the result fields for the
 * job record, or throws JobFailure with a sentence a person can act on.
 */
export function createHyperframesRunner(config) {
  async function probe(file, env, signal) {
    const res = await runProcess(config.ffprobeBin, buildProbeArgs(file), { cwd: dirname(file), env, timeoutMs: 60_000, signal });
    return res.code === 0 ? parseProbe(res.stdout) : null;
  }

  return async function run(job, { signal }) {
    const env = childEnv({ jobHome: job.paths.home, browserPath: config.browserPath });
    const timeoutMs = job.timeoutMs ?? config.jobTimeoutMs;
    const projectDir = job.paths.project;

    if (job.kind === "check") {
      const res = await runProcess(config.hyperframesBin, buildCheckArgs(projectDir), { cwd: projectDir, env, timeoutMs, signal });
      if (res.cancelled) throw new JobFailure("The job was cancelled.");
      if (res.timedOut) throw new JobFailure(`The check took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`);
      const report = parseCheckReport(res.stdout);
      if (!report) throw new JobFailure(`The check could not run.\n${tail(res.stderr || res.stdout)}`);
      return { passed: res.code === 0, report };
    }

    if (job.kind === "snapshot") {
      const outDir = join(job.paths.out, "snapshots");
      await mkdir(outDir, { recursive: true });
      const res = await runProcess(config.hyperframesBin, buildSnapshotArgs(projectDir, outDir, job.options.frames), { cwd: projectDir, env, timeoutMs, signal });
      if (res.cancelled) throw new JobFailure("The job was cancelled.");
      if (res.timedOut) throw new JobFailure(`The snapshot took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`);
      if (res.code !== 0) throw new JobFailure(`The snapshot failed.\n${tail(res.stderr || res.stdout)}`);
      const picked = await pickSnapshotOutput(outDir);
      if (!picked) throw new JobFailure("The snapshot made no pictures.");
      const info = await stat(picked.file);
      return { outputFile: picked.file, outputContentType: picked.contentType, outputBytes: info.size, frames: picked.frames };
    }

    const outFile = join(job.paths.out, "video.mp4");
    const args = buildRenderArgs({
      projectDir,
      entry: job.entry,
      outFile,
      fps: job.options.fps,
      quality: job.options.quality,
      workers: config.renderWorkers,
    });
    const res = await runProcess(config.hyperframesBin, args, {
      cwd: projectDir,
      env,
      timeoutMs,
      signal,
      onProgress: (progress) => {
        job.progress = progress;
      },
    });
    if (res.cancelled) throw new JobFailure("The job was cancelled.");
    if (res.timedOut) {
      throw new JobFailure(
        `The render took longer than ${Math.round(timeoutMs / 1000)} seconds, the time allowed for a video of ${job.options.maxDurationSeconds} seconds, and was stopped. ` +
          "Check that the length asked for matches the composition's real length.",
      );
    }
    if (res.code !== 0 || !existsSync(outFile)) throw new JobFailure(`The render failed.\n${tail(res.stderr || res.stdout)}`);
    const info = await stat(outFile);
    if (info.size > config.maxOutputBytes) {
      throw new JobFailure(`The video is ${info.size} bytes, more than the ${config.maxOutputBytes} bytes this renderer hands back.`);
    }
    const probed = await probe(outFile, env, signal);
    if (!probed?.hasVideo || probed.durationSeconds === null) throw new JobFailure("The render did not produce a readable video.");
    // Half a second of slack for encoder rounding.
    if (probed.durationSeconds > job.options.maxDurationSeconds + DURATION_SLACK_SECONDS) {
      throw new JobFailure(
        `The video is ${probed.durationSeconds.toFixed(1)} seconds long, more than the ${job.options.maxDurationSeconds} seconds allowed for this job.`,
      );
    }
    return {
      outputFile: outFile,
      outputContentType: "video/mp4",
      outputBytes: info.size,
      durationSeconds: probed.durationSeconds,
      width: probed.width,
      height: probed.height,
    };
  };
}

/** What the HTTP API shows for a job: never paths on disk. */
export function publicView(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    label: job.label,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.status === "running" ? (job.progress ?? null) : null,
    error: job.error,
    result: job.result
      ? {
          passed: job.result.passed ?? null,
          report: job.result.report ?? null,
          outputContentType: job.result.outputContentType ?? null,
          outputBytes: job.result.outputBytes ?? null,
          durationSeconds: job.result.durationSeconds ?? null,
          width: job.result.width ?? null,
          height: job.result.height ?? null,
          frames: job.result.frames ?? null,
          vendored: job.vendored.length > 0 ? job.vendored : undefined,
        }
      : null,
  };
}

/**
 * The queue. `runner(job, { signal })` does the work (createHyperframesRunner
 * in production, a fake in tests). `vendorAvailable(rel)` / `vendorPath(rel)`
 * describe the optional vendored libraries.
 */
export function createJobManager({ config, runner, vendorAvailable = () => false, vendorPath = (rel) => rel, now = () => new Date(), newId = randomUUID }) {
  const jobs = new Map();
  const waiting = [];
  let running = 0;
  let draining = false;

  function counts() {
    return { running, waiting: waiting.length, max: config.concurrency, maxWaiting: config.maxQueue };
  }

  async function removeDir(job) {
    await rm(job.paths.root, { recursive: true, force: true }).catch(() => {});
  }

  function finish(job, status, fields) {
    if (job.status === "cancelled") return;
    job.status = status;
    job.finishedAt = now().toISOString();
    Object.assign(job, fields);
  }

  async function runOne(job) {
    running += 1;
    job.status = "running";
    job.startedAt = now().toISOString();
    try {
      const result = await runner(job, { signal: job.abort.signal });
      finish(job, "done", { result, error: null });
    } catch (error) {
      const message = error instanceof JobFailure ? error.message : "The renderer hit an internal error.";
      finish(job, "failed", { error: message, result: null });
      if (!(error instanceof JobFailure)) console.error(`[render-worker] job ${job.id} crashed:`, error);
    } finally {
      running -= 1;
      // Nothing to hand back (a check, a failure, a cancel): free the disk
      // now. A finished job with an output keeps its directory until the
      // result TTL, so Paperclip can fetch it.
      if (!(job.status === "done" && job.result?.outputFile)) await removeDir(job);
      pump();
    }
  }

  function pump() {
    while (!draining && running < config.concurrency && waiting.length > 0) {
      const job = waiting.shift();
      if (job.status !== "queued") continue;
      void runOne(job);
    }
  }

  async function submit(body) {
    if (draining) throw new QueueFullError();
    if (!body || typeof body !== "object") throw new CompositionError("bad_request", "The request body must be a JSON object.");
    const kind = body.kind;
    if (!JOB_KINDS.includes(kind)) throw new CompositionError("bad_kind", `kind must be one of ${JOB_KINDS.join(", ")}.`);
    if (waiting.length >= config.maxQueue) throw new QueueFullError();

    const { entry, files } = validateComposition(body.composition, config.compositionLimits);
    const prepared = prepareCompositionFiles(files, vendorAvailable);
    const options = normalizeOptions(kind, body.options, config);
    // Refused before any browser starts: a composition longer than this job
    // may be would otherwise render until the time limit, then fail.
    assertCompositionLength(entry, prepared.files, options.maxDurationSeconds);
    const label = typeof body.label === "string" ? body.label.replace(/[^A-Za-z0-9 ._:-]/g, "").slice(0, 120) : null;

    const id = newId();
    const root = join(config.jobsDir, id);
    const paths = { root, project: join(root, "project"), home: join(root, "home"), out: join(root, "out") };
    await mkdir(paths.project, { recursive: true });
    await mkdir(paths.home, { recursive: true });
    await mkdir(paths.out, { recursive: true });
    try {
      for (const file of prepared.files) {
        const target = join(paths.project, file.path);
        await mkdir(dirname(target), { recursive: true });
        // "wx": never overwrite and never follow a pre-existing link.
        await writeFile(target, file.bytes, { flag: "wx" });
      }
      for (const rel of prepared.vendor) {
        const target = join(paths.project, "_paperclip_vendor", rel);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(vendorPath(rel), target);
      }
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    const job = {
      id,
      kind,
      label,
      entry,
      options,
      timeoutMs: jobTimeoutMs(kind, options, config),
      vendored: prepared.vendor,
      status: "queued",
      createdAt: now().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      result: null,
      paths,
      abort: new AbortController(),
    };
    jobs.set(id, job);
    waiting.push(job);
    pump();
    return publicView(job);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? publicView(job) : null;
  }

  /** The finished job's output file, or null when there is none (yet). */
  function output(id) {
    const job = jobs.get(id);
    if (!job || job.status !== "done" || !job.result?.outputFile) return null;
    return { file: job.result.outputFile, contentType: job.result.outputContentType, bytes: job.result.outputBytes };
  }

  /**
   * DELETE: stops a queued or running job, or releases a finished job's
   * files early (Paperclip calls it once it has stored the output).
   */
  async function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status === "queued" || job.status === "running") {
      const wasRunning = job.status === "running";
      job.status = "cancelled";
      job.finishedAt = now().toISOString();
      job.error = "The job was cancelled.";
      job.abort.abort();
      // A running job's directory goes when its children have exited (runOne's finally).
      if (!wasRunning) await removeDir(job);
      return publicView(job);
    }
    await removeDir(job);
    if (job.result?.outputFile) job.result = { ...job.result, outputFile: undefined };
    return publicView(job);
  }

  /** Forgets finished jobs older than the result TTL and deletes their files. */
  async function sweep() {
    const cutoff = now().getTime() - config.resultTtlMs;
    for (const job of jobs.values()) {
      if (!["done", "failed", "cancelled"].includes(job.status)) continue;
      const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : 0;
      if (finishedAt <= cutoff) {
        jobs.delete(job.id);
        await removeDir(job);
      }
    }
  }

  async function drain() {
    draining = true;
    for (const job of jobs.values()) {
      if (job.status === "queued" || job.status === "running") await cancel(job.id);
    }
  }

  return { submit, get, output, cancel, sweep, drain, counts };
}

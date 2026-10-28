import { z } from "zod";

/**
 * Media Studio code-rendered videos (D14; plan card "Code-rendered video
 * worker for infographics and explainers"): charts, titles and explainers
 * drawn by code, never by an image model. An agent (or a person) sends a
 * Hyperframes HTML composition; Paperclip forwards it to the locked-down
 * render worker (docker/render-worker) and saves the finished MP4 or contact
 * sheet in the company's Files.
 *
 * Three kinds of job, the same check-then-render rhythm as Brag:
 *   - check:    lint, layout overflow, contrast and timing in one browser
 *               pass; returns Hyperframes' report, makes no file.
 *   - snapshot: a contact sheet of evenly spaced frames (a JPEG in Files).
 *   - render:   the MP4 (in Files, or attached to the task).
 *
 * Rendering runs on the server's own CPU, so it costs no provider money; the
 * caps below are about box time. They stop and ask instead of running loose:
 * an agent that reaches one gets a plain "ask a person" answer.
 *
 * What a job counts against the daily caps (D7), so no job runs for free:
 *   - a finished render: its video length -- the length it asked for, the
 *     length its composition names, or the real length if that is longer;
 *   - a check, a contact sheet, and any failed or cancelled job: the time the
 *     renderer really spent on it;
 *   - a render still waiting or running: the length it reserved; a check or
 *     contact sheet: what it reserved, or the time it has run so far if that
 *     is more.
 */

export const CODE_RENDER_KINDS = ["check", "snapshot", "render"] as const;
export type CodeRenderKind = (typeof CODE_RENDER_KINDS)[number];

/** `saving` = the worker finished and Paperclip is copying the file into Files. */
export const CODE_RENDER_STATUSES = ["queued", "running", "saving", "done", "failed", "cancelled"] as const;
export type CodeRenderStatus = (typeof CODE_RENDER_STATUSES)[number];
export const CODE_RENDER_ACTIVE_STATUSES: readonly CodeRenderStatus[] = ["queued", "running", "saving"];

export const CODE_RENDER_QUALITIES = ["draft", "standard", "high"] as const;
export type CodeRenderQuality = (typeof CODE_RENDER_QUALITIES)[number];

export interface CodeRenderLimits {
  /** Longest video one render may ask for. */
  maxVideoSeconds: number;
  /** Seconds per agent per day (UTC), across all its jobs: finished video plus the renderer's time on everything else. */
  agentDailyVideoSeconds: number;
  /** Seconds per company per day (UTC), counted the same way; agents are held to it. */
  companyDailyVideoSeconds: number;
  /** Jobs of any kind waiting or running for one company at once. */
  maxActiveJobsPerCompany: number;
  /** Media Studio files sent with one job, in bytes. */
  maxAssetBytes: number;
}

/** Defaults; an operator can change each with a PAPERCLIP_CODE_RENDER_* variable (see the render worker README). */
export const CODE_RENDER_DEFAULT_LIMITS: CodeRenderLimits = Object.freeze({
  maxVideoSeconds: 600,
  agentDailyVideoSeconds: 1_200,
  companyDailyVideoSeconds: 3_600,
  maxActiveJobsPerCompany: 2,
  maxAssetBytes: 100 * 1024 * 1024,
});

/** Never above this, whatever the settings say: the long-form film cap (D7: 10-30 min). */
export const CODE_RENDER_HARD_MAX_VIDEO_SECONDS = 1_800;

/** Encoder rounding allowed when a length is compared with another (the worker uses the same). */
export const CODE_RENDER_DURATION_SLACK_SECONDS = 0.5;

/**
 * What a check or contact sheet holds against the daily caps while it waits
 * or runs. Once the renderer is done, the job counts the time it really took.
 */
export const CODE_RENDER_CHECK_RESERVE_SECONDS = 60;

/**
 * The longest a job can hold the renderer (the worker's default
 * RENDER_WORKER_JOB_TIMEOUT_SECONDS). A run time Paperclip has to guess from
 * its own clock (the worker forgot the job, or has not answered yet) is never
 * charged above this.
 */
export const CODE_RENDER_MAX_JOB_SECONDS = 1_800;

export const CODE_RENDER_EXPLANATION =
  "Code-drawn videos (charts, titles, explainers) are made on this server's own computer, so they cost no AI money. " +
  "To keep the server free for everything else, each agent may use a limited number of minutes per day, the company a limited number in total, and only a few jobs run at once. " +
  "A finished video counts its length; checks, previews and failed or stopped jobs count the time the renderer spent on them. " +
  "When a limit is reached the agent stops and asks a person.";

// HTML comments, and opening tags (quoted attribute values may hold ">").
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const OPENING_TAG_PATTERN = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?>/g;

const TIMING_ATTRIBUTE_PATTERNS = {
  "data-start": /\sdata-start\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
  "data-duration": /\sdata-duration\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i,
} as const;

function timingAttribute(tag: string, name: keyof typeof TIMING_ATTRIBUTE_PATTERNS): number | null {
  const match = TIMING_ATTRIBUTE_PATTERNS[name].exec(tag);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim().replace(/s$/i, "");
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * How long a composition says it runs, in seconds, read from its entry HTML:
 * the latest `data-start` + `data-duration` of any timed element, the root's
 * `data-duration` included. null when the file names no length at all.
 *
 * An estimate made before anything renders (the worker makes the same one and
 * checks the real video afterwards): a render whose composition is longer than
 * its `durationSeconds` is refused up front instead of holding the renderer.
 * Numbers only; a start that names another clip counts as 0.
 */
export function estimateCompositionSeconds(html: string): number | null {
  let longest: number | null = null;
  for (const tag of html.replace(HTML_COMMENT_PATTERN, "").match(OPENING_TAG_PATTERN) ?? []) {
    const duration = timingAttribute(tag, "data-duration");
    if (duration === null) continue;
    const end = (timingAttribute(tag, "data-start") ?? 0) + duration;
    if (longest === null || end > longest) longest = end;
  }
  return longest;
}

/** Same rules the worker applies: relative, plain ASCII names, no hidden files, no "..". */
export const CODE_RENDER_PATH_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/){0,7}[A-Za-z0-9_][A-Za-z0-9._-]*\.[A-Za-z0-9]+$/;

const compositionPathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => CODE_RENDER_PATH_PATTERN.test(value) && !value.split("/").some((part) => part === "." || part === ".."), {
    message: 'Use a relative path such as "index.html" or "assets/logo.png": letters, digits, "-", "_", "." only, no hidden files, no "..".',
  });

export const codeRenderFileSchema = z
  .object({
    path: compositionPathSchema,
    /** UTF-8 text: HTML, CSS, JavaScript, SVG, JSON, subtitles. */
    content: z.string().max(5_000_000).optional(),
    /** A small binary file (a sound effect, an icon) sent inline; larger ones go through `assets`. The whole request stays under 10 MB. */
    contentBase64: z.string().max(7_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/, "contentBase64 must be base64").optional(),
  })
  .strict()
  .refine((file) => (file.content === undefined) !== (file.contentBase64 === undefined), {
    message: "Give each file either content (text) or contentBase64 (binary), not both.",
  });

export const codeRenderAssetSchema = z
  .object({
    /** A file in this company's Files (Media Studio pictures, music, fonts): its id on the Files page. */
    fileId: z.string().uuid(),
    /** Where the composition expects it, e.g. "assets/logo.png". */
    path: compositionPathSchema,
  })
  .strict();

export const submitCodeRenderSchema = z
  .object({
    kind: z.enum(CODE_RENDER_KINDS),
    /** Shown in Files and the activity log, e.g. "Q3 orders infographic". */
    title: z.string().trim().min(1).max(200),
    /** The composition's entry file; defaults to index.html. */
    entry: compositionPathSchema.optional(),
    files: z.array(codeRenderFileSchema).min(1).max(200),
    assets: z.array(codeRenderAssetSchema).max(50).optional(),
    /** How long the video runs. Needed for a render: checked against the caps before it starts, and the finished video may not be longer. */
    durationSeconds: z.number().positive().max(CODE_RENDER_HARD_MAX_VIDEO_SECONDS).optional(),
    fps: z.number().int().min(1).max(60).optional(),
    quality: z.enum(CODE_RENDER_QUALITIES).optional(),
    /** Snapshot only: how many frames go on the contact sheet. */
    frames: z.number().int().min(1).max(24).optional(),
    /** Attach the result to this task instead of saving it as a company file. */
    issueId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "render" && value.durationSeconds === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["durationSeconds"], message: "A render needs durationSeconds (how long the video runs)." });
    }
    const seen = new Set<string>();
    for (const path of [...value.files.map((f) => f.path), ...(value.assets ?? []).map((a) => a.path)]) {
      const key = path.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: `"${path}" is listed twice.` });
        return;
      }
      seen.add(key);
    }
  });
export type SubmitCodeRenderInput = z.infer<typeof submitCodeRenderSchema>;

export interface CodeRenderJob {
  id: string;
  companyId: string;
  kind: CodeRenderKind;
  status: CodeRenderStatus;
  title: string;
  issueId: string | null;
  /** The length asked for (render), in seconds. */
  durationSeconds: number | null;
  /** The finished video's real length, in seconds. */
  videoSeconds: number | null;
  /**
   * What this job counts against the daily caps, in seconds: held while it
   * waits or runs, then its video length (a finished render) or the
   * renderer's real time (everything else).
   */
  chargedSeconds: number;
  /** 0-100 while the worker renders. */
  progressPct: number | null;
  /** The saved file (Files page id): the MP4 for a render, the contact sheet for a snapshot. */
  resultFileId: string | null;
  resultContentType: string | null;
  resultBytes: number | null;
  /** Check only: whether Hyperframes found no errors, and its full report. */
  passed: boolean | null;
  report: Record<string, unknown> | null;
  error: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CodeRenderUsage {
  limits: CodeRenderLimits;
  /** Seconds counted against the company's daily cap today (UTC), every job's chargedSeconds. */
  companySecondsToday: number;
  activeJobs: number;
  configured: boolean;
}

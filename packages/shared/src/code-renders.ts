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
  /** Finished video per agent per day (UTC), across all its renders. */
  agentDailyVideoSeconds: number;
  /** Finished video per company per day (UTC), counting agents' renders. */
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

export const CODE_RENDER_EXPLANATION =
  "Code-drawn videos (charts, titles, explainers) are made on this server's own computer, so they cost no AI money. " +
  "To keep the server free for everything else, each agent may make a limited number of minutes per day, the company a limited number in total, and only a few at once. " +
  "When a limit is reached the agent stops and asks a person.";

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
  /** Finished or running video seconds today (UTC). */
  companySecondsToday: number;
  activeJobs: number;
  configured: boolean;
}

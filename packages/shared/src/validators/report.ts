import { z } from "zod";

/**
 * DUR-4072 PR1: the calculation-script runner. Limits here bound what the
 * server ever writes to the database or hands to the sandboxed runner --
 * they are the first line of defense, not the whole sandbox.
 */

export const REPORT_SCRIPT_KEY_MAX_LENGTH = 100;
export const REPORT_SCRIPT_NAME_MAX_LENGTH = 200;
export const REPORT_SCRIPT_MAX_FILES = 50;
/** Total size across every file in a version (bytes), before the lockfile. */
export const REPORT_SCRIPT_MAX_TOTAL_FILE_BYTES = 2_000_000;
export const REPORT_SCRIPT_MAX_LOCKFILE_BYTES = 500_000;
export const REPORT_FIXTURE_NAME_MAX_LENGTH = 200;

const reportScriptKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(REPORT_SCRIPT_KEY_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "Key must be lowercase letters, numbers, hyphens or underscores, starting with a letter or number.",
  });

/**
 * A path a script's `files` map may use: relative, forward-slash separated,
 * no leading slash and no `..` segment -- so a version's files can only ever
 * land inside the runtime directory the runner builds for it, never escape
 * it. Enforced here (input boundary) and re-checked by the runner before
 * every write to disk.
 */
const reportScriptFilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith("/") && !value.startsWith("\\"), {
    message: "File paths must be relative.",
  })
  .refine((value) => !value.split(/[\\/]/).some((segment) => segment === ".." || segment === "."), {
    message: "File paths may not contain '.' or '..' segments.",
  });

const reportScriptFilesSchema = z
  .record(reportScriptFilePathSchema, z.string())
  .refine((files) => Object.keys(files).length > 0, { message: "At least one file is required." })
  .refine((files) => Object.keys(files).length <= REPORT_SCRIPT_MAX_FILES, {
    message: `A script version may hold at most ${REPORT_SCRIPT_MAX_FILES} files.`,
  })
  .refine(
    (files) => Object.values(files).reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0) <= REPORT_SCRIPT_MAX_TOTAL_FILE_BYTES,
    { message: `The script's files may total at most ${REPORT_SCRIPT_MAX_TOTAL_FILE_BYTES} bytes.` },
  );

export const createReportScriptSchema = z.object({
  key: reportScriptKeySchema,
  name: z.string().trim().min(1).max(REPORT_SCRIPT_NAME_MAX_LENGTH),
  description: z.string().trim().max(2000).optional(),
});
export type CreateReportScriptInput = z.infer<typeof createReportScriptSchema>;

export const createReportScriptVersionSchema = z
  .object({
    files: reportScriptFilesSchema,
    entrypoint: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_.\-/]+\.py$/, { message: "Entrypoint must be a .py file path." })
      .default("main.py"),
    lockfile: z.string().max(REPORT_SCRIPT_MAX_LOCKFILE_BYTES).optional(),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    changeSummary: z.string().trim().max(2000).optional(),
  })
  .refine((value) => Object.prototype.hasOwnProperty.call(value.files, value.entrypoint), {
    message: "entrypoint must be one of the provided files.",
    path: ["entrypoint"],
  });
export type CreateReportScriptVersionInput = z.infer<typeof createReportScriptVersionSchema>;

export const approveReportScriptVersionSchema = z.object({
  changeSummary: z.string().trim().max(2000).optional(),
});
export type ApproveReportScriptVersionInput = z.infer<typeof approveReportScriptVersionSchema>;

export const createReportFixtureSchema = z.object({
  name: z.string().trim().min(1).max(REPORT_FIXTURE_NAME_MAX_LENGTH),
  input: z.unknown(),
  expectedOutput: z.unknown(),
  tolerance: z.number().min(0).max(1_000_000_000).default(0),
});
export type CreateReportFixtureInput = z.infer<typeof createReportFixtureSchema>;

export const runReportScriptFixtureSchema = z.object({
  fixtureId: z.string().uuid(),
});
export type RunReportScriptFixtureInput = z.infer<typeof runReportScriptFixtureSchema>;

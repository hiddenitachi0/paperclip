import { z } from "zod";
import {
  LANE_A_BACKUP_MODELS_MAX,
  LANE_A_BACKUP_ID_MAX_LENGTH,
  LANE_A_BASE_URL_MAX_LENGTH,
  LANE_A_FREE_FORM_MODEL_MAX_LENGTH,
  LANE_A_KEYWORD_ROUTES_MAX,
  LANE_A_KEYWORD_ROUTE_PHRASES_MAX,
  LANE_A_KEYWORD_ROUTE_PHRASE_MAX_LENGTH,
  LANE_A_MAX_TEMPERATURE,
  LANE_A_MIN_TEMPERATURE,
  LANE_A_PROVIDERS,
  laneABackupModelEntryIssue,
} from "../lane-a-models.js";

// DUR-217: POST /api/lane-a/:agentId/messages body. Lane A is a direct
// model-call text primitive — companyId scopes the request the same way
// every other route does, conversationId resumes an existing thread (turn
// cap + idle timeout enforced server-side), context is optional caller-
// supplied grounding text (e.g. the product row a dashboard button is
// attached to), never executable.
export const sendLaneAMessageSchema = z.object({
  companyId: z.string().uuid(),
  message: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(),
  context: z.string().max(16000).optional(),
});

export type SendLaneAMessage = z.infer<typeof sendLaneAMessageSchema>;

// ─── DUR-3977: the stateless transform call ──────────────────────────────────
//
// POST /api/lane-a/:agentId/transform is the batch-caller shape of Lane A:
// one text in, one text out, no conversation, no transcript, no tools. The
// company is never taken from the body — it comes from the service token the
// caller authenticated with, and the agent is then checked against it
// server-side (see server/src/routes/lane-a.ts).

/** Upper bound on the text a single transform call may be given. */
export const LANE_A_TRANSFORM_INPUT_MAX_LENGTH = 24_000;
/** How many named fields one call may carry alongside the input text. */
export const LANE_A_TRANSFORM_MAX_VARIABLES = 40;
/** Upper bound on one variable's value once stringified. */
export const LANE_A_TRANSFORM_VARIABLE_VALUE_MAX_LENGTH = 4_000;
/**
 * Upper bound on the WHOLE request payload: the input text plus every
 * variable name and value, measured in characters.
 *
 * Bounding each field separately is not a bound. 24 000 input characters plus
 * 40 variables of 4 000 each is 184 000 characters — roughly 46 000 input
 * tokens, about $0.23 of input per call on the most expensive model an
 * operator can pick. Multiplied by the default daily cap of 2 000 calls that
 * is several hundred dollars a day for one agent, reachable without the
 * operator setting anything. The real payload this endpoint exists for (one
 * product row: a description plus a handful of labelled fields) is an order
 * of magnitude under this ceiling, so the limit costs the actual caller
 * nothing and removes the worst case entirely.
 */
export const LANE_A_TRANSFORM_MAX_TOTAL_CHARS = 24_000;
/** Upper bound a caller may ask for with maxOutputChars. */
export const LANE_A_TRANSFORM_MAX_OUTPUT_CHARS = 40_000;

/**
 * How many transform calls one caller may have in flight at the same time
 * (DUR-3977 acceptance item 6). There is deliberately no batch endpoint: see
 * the long note on `transform` in server/src/services/lane-a.ts for why
 * parallel single calls were chosen instead. The server enforces this number
 * per agent, per server process, and answers a 429 above it — so it is a real
 * limit, not only documentation.
 */
export const LANE_A_TRANSFORM_MAX_CONCURRENCY = 4;

const transformVariableValueSchema = z.union([
  z.string().max(LANE_A_TRANSFORM_VARIABLE_VALUE_MAX_LENGTH),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * Exactly what the server will count against LANE_A_TRANSFORM_MAX_TOTAL_CHARS:
 * the input text, plus every variable's name and its stringified value. A
 * `null` value contributes nothing beyond its name, because that is how
 * buildTransformUserMessage renders it. Exported so a caller can measure a
 * payload before sending it and split the work itself, rather than finding
 * out with a 400.
 */
export function laneATransformPayloadChars(payload: {
  input: string;
  variables?: Record<string, string | number | boolean | null> | null;
}): number {
  let total = payload.input.length;
  for (const [key, value] of Object.entries(payload.variables ?? {})) {
    total += key.length;
    if (value !== null && value !== undefined) total += String(value).length;
  }
  return total;
}

export const laneATransformSchema = z.object({
  input: z.string().trim().min(1).max(LANE_A_TRANSFORM_INPUT_MAX_LENGTH),
  /**
   * Named fields belonging to the one row being transformed (product name,
   * vendor, target language, ...). They are rendered into the user turn as
   * clearly-labelled DATA, never substituted into the agent's instructions —
   * a vendor-supplied product name must not be able to rewrite the prompt.
   */
  variables: z
    .record(z.string().min(1).max(120), transformVariableValueSchema)
    .refine((value) => Object.keys(value).length <= LANE_A_TRANSFORM_MAX_VARIABLES, {
      message: `At most ${LANE_A_TRANSFORM_MAX_VARIABLES} variables per call`,
    })
    .optional(),
  /**
   * Hard ceiling on the returned text, in characters.
   *
   * It does three things, in this order: the system prompt asks the model to
   * stay at or under it, the model's own `max_tokens` for this call is lowered
   * to roughly match it (see resolveTransformMaxTokens in
   * server/src/services/lane-a.ts — so asking for a 200-character blurb is
   * genuinely cheaper, not merely trimmed afterwards), and anything still over
   * the ceiling is cut, with `truncated: true` in the response.
   */
  maxOutputChars: z.number().int().positive().max(LANE_A_TRANSFORM_MAX_OUTPUT_CHARS).optional(),
}).superRefine((value, ctx) => {
  const total = laneATransformPayloadChars(value);
  if (total > LANE_A_TRANSFORM_MAX_TOTAL_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `The whole request is ${total} characters; the limit is ${LANE_A_TRANSFORM_MAX_TOTAL_CHARS} ` +
        `across the input text and every variable name and value combined. Send fewer or shorter fields.`,
      path: ["input"],
    });
  }
});

export type LaneATransform = z.infer<typeof laneATransformSchema>;

// ─── DUR-4347: backup-model pool, fallback chains & keyword routing ─────────

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // Same shape check as the main model's laneABaseUrl (validators/agent.ts):
    // the server appends /chat/completions, so a query string, fragment or
    // sign-in part would ride along on every request.
    if (url.search || url.hash || url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

const laneABackupIdSchema = z.string().trim().min(1).max(LANE_A_BACKUP_ID_MAX_LENGTH);

/**
 * One backup-pool entry. Mirrors the main model's own fields (provider,
 * model, baseUrl, temperature) plus a stable `id`. Field shapes match the
 * main model's create/update schema (validators/agent.ts); cross-field fit
 * (provider/model, free-form-provider-needs-baseUrl) is checked in
 * `laneABackupModelEntryIssue` below via `.superRefine`.
 */
export const laneABackupModelEntrySchema = z
  .object({
    id: laneABackupIdSchema,
    provider: z.enum(LANE_A_PROVIDERS),
    model: z.string().trim().min(1).max(LANE_A_FREE_FORM_MODEL_MAX_LENGTH),
    baseUrl: z
      .string()
      .trim()
      .max(LANE_A_BASE_URL_MAX_LENGTH)
      .refine(isHttpUrl, "The model address must be a plain http(s) URL with no query string or sign-in part.")
      .nullable()
      .optional(),
    temperature: z
      .number()
      .finite()
      .min(LANE_A_MIN_TEMPERATURE, `Creativity must be between ${LANE_A_MIN_TEMPERATURE} and ${LANE_A_MAX_TEMPERATURE}.`)
      .max(LANE_A_MAX_TEMPERATURE, `Creativity must be between ${LANE_A_MIN_TEMPERATURE} and ${LANE_A_MAX_TEMPERATURE}.`)
      .nullable()
      .optional(),
  })
  .strict();

export type LaneABackupModelEntryInput = z.infer<typeof laneABackupModelEntrySchema>;

/**
 * The whole backup-model pool: at most 5 entries, each a unique `id`, each
 * fitting its own provider (same rule as the main model) and carrying a base
 * URL when its provider needs one (laneABackupModelEntryIssue).
 */
export const laneABackupModelsSchema = z
  .array(laneABackupModelEntrySchema)
  .max(LANE_A_BACKUP_MODELS_MAX, `List at most ${LANE_A_BACKUP_MODELS_MAX} backup models.`)
  .superRefine((entries, ctx) => {
    const seenIds = new Set<string>();
    entries.forEach((entry, index) => {
      if (seenIds.has(entry.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Backup model id "${entry.id}" is used more than once.`,
          path: [index, "id"],
        });
      }
      seenIds.add(entry.id);
      if (entry.id === "main") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Backup model id "main" is reserved for the main model.',
          path: [index, "id"],
        });
      }
      const issue = laneABackupModelEntryIssue(entry);
      if (issue) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: [index, "model"] });
      }
    });
  });

export type LaneABackupModels = z.infer<typeof laneABackupModelsSchema>;

/**
 * One fallback chain: an ordered list of backup-pool ids, no duplicates.
 * Whether every id actually exists in the pool is a cross-field check (the
 * pool and the chain are sibling fields on the same agent-settings patch) —
 * see `laneABackupRoutingIssues` below, run from validators/agent.ts.
 */
export const laneAChainIdsSchema = z
  .array(laneABackupIdSchema)
  .max(LANE_A_BACKUP_MODELS_MAX)
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${id}" appears more than once in this chain.`, path: [index] });
      }
      seen.add(id);
    });
  });

export type LaneAChainIds = z.infer<typeof laneAChainIdsSchema>;

const laneAKeywordPhraseSchema = z.string().trim().min(1).max(LANE_A_KEYWORD_ROUTE_PHRASE_MAX_LENGTH);

/**
 * One keyword-routing rule: a non-empty, deduplicated list of phrases and the
 * pool entry (`backupId`) they route to. Whether `backupId` actually exists
 * in the pool is checked alongside the chains in `laneABackupRoutingIssues`.
 */
export const laneAKeywordRouteSchema = z
  .object({
    id: laneABackupIdSchema,
    phrases: z
      .array(laneAKeywordPhraseSchema)
      .min(1, "A keyword rule needs at least one phrase.")
      .max(LANE_A_KEYWORD_ROUTE_PHRASES_MAX, `List at most ${LANE_A_KEYWORD_ROUTE_PHRASES_MAX} phrases per rule.`)
      .superRefine((phrases, ctx) => {
        const seen = new Set<string>();
        phrases.forEach((phrase, index) => {
          const key = phrase.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${phrase}" is listed more than once.`, path: [index] });
          }
          seen.add(key);
        });
      }),
    backupId: laneABackupIdSchema,
  })
  .strict();

export type LaneAKeywordRouteInput = z.infer<typeof laneAKeywordRouteSchema>;

export const laneAKeywordRoutesSchema = z
  .array(laneAKeywordRouteSchema)
  .max(LANE_A_KEYWORD_ROUTES_MAX, `List at most ${LANE_A_KEYWORD_ROUTES_MAX} keyword rules.`)
  .superRefine((routes, ctx) => {
    const seen = new Set<string>();
    routes.forEach((route, index) => {
      if (seen.has(route.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Keyword rule id "${route.id}" is used more than once.`,
          path: [index, "id"],
        });
      }
      seen.add(route.id);
    });
  });

export type LaneAKeywordRoutes = z.infer<typeof laneAKeywordRoutesSchema>;

/**
 * Cross-field checks that need the pool alongside the chains/routes — the
 * four fields are siblings on the same agent-settings patch (createAgentSchema
 * /updateAgentSchema in validators/agent.ts), so this runs from that object's
 * `.superRefine`, not from any one field's own schema. Returns plain issues
 * (path + message) for the caller to `ctx.addIssue`.
 */
export function laneABackupRoutingIssues(input: {
  laneABackupModels?: LaneABackupModelEntryInput[] | null;
  laneANoAnswerChainIds?: LaneAChainIds | null;
  laneARefusalChainIds?: LaneAChainIds | null;
  laneAKeywordRoutes?: LaneAKeywordRouteInput[] | null;
}): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const pool = input.laneABackupModels;
  // Nothing to cross-check against a pool when it was not part of this patch;
  // a chain/route id is only meaningful once the pool is also known, and an
  // agent-settings PATCH always sends all four together (see
  // server/src/routes/agents.ts) so this is reached with the real pool in
  // practice.
  const poolIds = new Set((pool ?? []).map((entry) => entry.id));
  const checkChain = (ids: LaneAChainIds | null | undefined, field: string) => {
    if (!ids || pool === undefined) return;
    ids.forEach((id, index) => {
      if (!poolIds.has(id)) {
        issues.push({ path: [field, index], message: `"${id}" is not one of this quick agent's backup models.` });
      }
    });
  };
  checkChain(input.laneANoAnswerChainIds, "laneANoAnswerChainIds");
  checkChain(input.laneARefusalChainIds, "laneARefusalChainIds");
  const routes = input.laneAKeywordRoutes;
  if (routes && pool !== undefined) {
    routes.forEach((route, index) => {
      if (!poolIds.has(route.backupId)) {
        issues.push({
          path: ["laneAKeywordRoutes", index, "backupId"],
          message: `"${route.backupId}" is not one of this quick agent's backup models.`,
        });
      }
    });
  }
  return issues;
}

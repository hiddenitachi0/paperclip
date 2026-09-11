import { z } from "zod";

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

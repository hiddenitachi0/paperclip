import { z } from "zod";

/**
 * DUR-4392: the converter engine. A "converter" is a per-entry, ordered list
 * of declarative operations from this fixed allow-list -- data, not code --
 * that the model setup reviewer job (DUR-4558) proposes after probing an
 * entry (DUR-4557) and finding a gap between what the host supports and what
 * Paperclip currently sends. This module is the only thing that interprets
 * that data: it refuses any shape not on the allow-list, and it never calls a
 * tool, reaches a host, or runs arbitrary code -- it only reshapes the
 * request Paperclip was already going to send, and the text Paperclip
 * already got back.
 *
 * Every op here mirrors a tonight's-case fix that already exists as a
 * hand-written special case elsewhere (laneAThinkingForCall /
 * laneAModelAcceptsReasoningEffort in lane-a-models.ts for reasoning_effort,
 * the <think>-stripping in lane-a.ts for qwen3-style output). The engine does
 * not replace those -- it is the generalized path a reviewer job can reach
 * for the *next* case, without a human hand-writing a new allow-list entry
 * each time.
 */

export const MODEL_CONVERTER_OPS = [
  "drop_param",
  "rename_param",
  "set_default_param",
  "cap_tool_count",
  "tool_description_variant",
  "system_prompt_hint",
  "strip_output_wrapper",
  "parse_text_tool_call",
  "retry_once",
] as const;
export type ModelConverterOpKind = (typeof MODEL_CONVERTER_OPS)[number];

const paramNameSchema = z.string().trim().min(1).max(100);
const jsonPrimitiveSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const TOOL_DESCRIPTION_VARIANTS = ["short", "plain"] as const;
export type ToolDescriptionVariant = (typeof TOOL_DESCRIPTION_VARIANTS)[number];

/** `<think>` today; kept as an enum (not a free regex) so a converter can never inject one. */
export const OUTPUT_WRAPPERS = ["think"] as const;
export type OutputWrapper = (typeof OUTPUT_WRAPPERS)[number];

const dropParamOpSchema = z.object({ op: z.literal("drop_param"), param: paramNameSchema }).strict();
const renameParamOpSchema = z
  .object({ op: z.literal("rename_param"), from: paramNameSchema, to: paramNameSchema })
  .strict();
const setDefaultParamOpSchema = z
  .object({ op: z.literal("set_default_param"), param: paramNameSchema, value: jsonPrimitiveSchema })
  .strict();
const capToolCountOpSchema = z.object({ op: z.literal("cap_tool_count"), max: z.number().int().min(0).max(128) }).strict();
const toolDescriptionVariantOpSchema = z
  .object({ op: z.literal("tool_description_variant"), variant: z.enum(TOOL_DESCRIPTION_VARIANTS) })
  .strict();
const systemPromptHintOpSchema = z
  .object({ op: z.literal("system_prompt_hint"), hint: z.string().trim().min(1).max(500) })
  .strict();
const stripOutputWrapperOpSchema = z.object({ op: z.literal("strip_output_wrapper"), wrapper: z.enum(OUTPUT_WRAPPERS) }).strict();
const parseTextToolCallOpSchema = z.object({ op: z.literal("parse_text_tool_call") }).strict();
const retryOnceOpSchema = z
  .object({
    op: z.literal("retry_once"),
    onError: z.string().trim().min(1).max(200),
    withParams: z.record(paramNameSchema, jsonPrimitiveSchema),
  })
  .strict();

/** Discriminated union of every op the engine accepts; anything else is refused at parse time. */
export const modelConverterOpSchema = z.discriminatedUnion("op", [
  dropParamOpSchema,
  renameParamOpSchema,
  setDefaultParamOpSchema,
  capToolCountOpSchema,
  toolDescriptionVariantOpSchema,
  systemPromptHintOpSchema,
  stripOutputWrapperOpSchema,
  parseTextToolCallOpSchema,
  retryOnceOpSchema,
]);
export type ModelConverterOp = z.infer<typeof modelConverterOpSchema>;

export const modelConverterOpListSchema = z.array(modelConverterOpSchema).max(20);

/**
 * Parses and validates a converter op list from storage/input. Throws
 * (via ZodError) on any op not on the allow-list or any malformed shape --
 * callers must not persist or apply an unvalidated list.
 */
export function parseModelConverterOps(raw: unknown): ModelConverterOp[] {
  return modelConverterOpListSchema.parse(raw);
}

/** Same as parseModelConverterOps, but returns a plain-English reason instead of throwing. */
export function modelConverterOpsIssue(raw: unknown): string | null {
  const result = modelConverterOpListSchema.safeParse(raw);
  if (result.success) return null;
  const first = result.error.issues[0];
  if (!first) return "This converter list isn't valid.";
  if (first.code === "invalid_union_discriminator") {
    return `"${String((first as { options?: unknown[] }).options?.[0] ?? "")}" isn't a converter operation Paperclip knows.`;
  }
  return `This converter isn't valid: ${first.message}`;
}

export interface ConverterToolShape {
  name: string;
  description: string;
  shortDescription?: string | null;
  plainDescription?: string | null;
}

/** The request shape converters reshape, before it goes out on the wire. Never a key. */
export interface ConverterCallRequest {
  params: Record<string, string | number | boolean | null>;
  tools: ConverterToolShape[];
  systemPrompt: string;
  /** Set by parse_text_tool_call; the caller still does the actual parsing. */
  textToolCallParsingEnabled: boolean;
}

export interface ConverterApplyResult {
  request: ConverterCallRequest;
  appliedOps: ModelConverterOp[];
}

function applyOneRequestOp(request: ConverterCallRequest, op: ModelConverterOp): ConverterCallRequest {
  switch (op.op) {
    case "drop_param": {
      if (!(op.param in request.params)) return request;
      const { [op.param]: _dropped, ...rest } = request.params;
      return { ...request, params: rest };
    }
    case "rename_param": {
      if (!(op.from in request.params)) return request;
      const { [op.from]: value, ...rest } = request.params;
      return { ...request, params: { ...rest, [op.to]: value } };
    }
    case "set_default_param": {
      if (request.params[op.param] !== undefined) return request;
      return { ...request, params: { ...request.params, [op.param]: op.value } };
    }
    case "cap_tool_count": {
      if (request.tools.length <= op.max) return request;
      return { ...request, tools: request.tools.slice(0, op.max) };
    }
    case "tool_description_variant": {
      const tools = request.tools.map((tool) => {
        const variant = op.variant === "short" ? tool.shortDescription : tool.plainDescription;
        return variant ? { ...tool, description: variant } : tool;
      });
      return { ...request, tools };
    }
    case "system_prompt_hint": {
      const systemPrompt = request.systemPrompt.trim().length > 0 ? `${request.systemPrompt}\n\n${op.hint}` : op.hint;
      return { ...request, systemPrompt };
    }
    case "parse_text_tool_call":
      return { ...request, textToolCallParsingEnabled: true };
    // strip_output_wrapper and retry_once are not request-shaping ops; see
    // applyOutputConverters / resolveConverterRetry.
    case "strip_output_wrapper":
    case "retry_once":
      return request;
    default: {
      const unreachable: never = op;
      throw new Error(`Unhandled converter op: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Applies every request-shaping op, in order, to one call request. Pure; no I/O. */
export function applyRequestConverters(request: ConverterCallRequest, ops: readonly ModelConverterOp[]): ConverterApplyResult {
  const requestShapingOps = ops.filter((op) => op.op !== "strip_output_wrapper" && op.op !== "retry_once");
  const result = requestShapingOps.reduce(applyOneRequestOp, request);
  return { request: result, appliedOps: requestShapingOps };
}

const OUTPUT_WRAPPER_PATTERNS: Record<OutputWrapper, RegExp> = {
  think: /<think>[\s\S]*?<\/think>\s*/gi,
};

/** Strips every configured output wrapper (e.g. `<think>...</think>`) from model output text. Pure; no I/O. */
export function applyOutputConverters(text: string, ops: readonly ModelConverterOp[]): string {
  let result = text;
  for (const op of ops) {
    if (op.op !== "strip_output_wrapper") continue;
    result = result.replace(OUTPUT_WRAPPER_PATTERNS[op.wrapper], "");
  }
  return result;
}

/**
 * The retry-once params for this error, or null if no `retry_once` op
 * matches. The caller (lane-a's call site) is responsible for only retrying
 * once per call; this function is stateless and always returns the same
 * answer for the same (ops, errorCode) pair.
 */
export function resolveConverterRetry(
  ops: readonly ModelConverterOp[],
  errorCode: string,
): Record<string, string | number | boolean | null> | null {
  const match = ops.find((op) => op.op === "retry_once" && op.onError === errorCode);
  return match && match.op === "retry_once" ? match.withParams : null;
}

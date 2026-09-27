import { z } from "zod";

// DUR-4004: "API with a key" -- the third kind of tool on the Tools page.
// A service that hands out an API key and a plain HTTP API (Fal.ai, Fiken,
// ...). Everything here is what the Tools form and the import-from-OpenAPI
// preview produce; the key itself is never part of any of these shapes --
// only the id of the company secret that holds it.

export const API_TOOL_AUTH_KINDS = ["bearer", "header", "query"] as const;
export type ApiToolAuthKind = (typeof API_TOOL_AUTH_KINDS)[number];

export const API_TOOL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiToolMethod = (typeof API_TOOL_METHODS)[number];

// What one input to an action is. `json` is a whole JSON value (object or
// array) passed through as-is -- what an imported request body with nested
// fields becomes.
export const API_TOOL_INPUT_TYPES = ["string", "number", "integer", "boolean", "json"] as const;
export type ApiToolInputType = (typeof API_TOOL_INPUT_TYPES)[number];

export const API_TOOL_MAX_ACTIONS = 40;
export const API_TOOL_MAX_INPUTS_PER_ACTION = 40;
export const API_TOOL_DEFAULT_DAILY_CAP = 300;
export const API_TOOL_MAX_DAILY_CAP = 100_000;

/** Action names and input names: what a model can type as a tool name part. */
export const API_TOOL_ACTION_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const API_TOOL_INPUT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
// RFC 7230 header field-name token characters.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const QUERY_NAME_RE = /^[A-Za-z0-9_.\-[\]]{1,128}$/;

/**
 * The base address: https only, a public-looking host name, no username or
 * password, no query string or fragment. A path prefix (e.g. `/api/v2`) is
 * fine and is kept. Returns the normalised address (no trailing slash) or a
 * plain sentence saying what is wrong.
 */
export function normalizeApiToolBaseUrl(input: string): { ok: true; url: string; host: string } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, message: "Enter the base address, e.g. https://fal.run." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "The base address is not a valid web address. It should start with https://." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: "The base address must start with https://. Plain http is not allowed." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "The base address cannot contain a username or password. The key goes in Secrets." };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, message: "The base address cannot contain a query string (?...) or a fragment (#...)." };
  }
  if (parsed.port && parsed.port !== "443") {
    return { ok: false, message: "Only the default https port (443) is allowed." };
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /\.(local|internal|lan|localhost)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(":")) {
    return { ok: false, message: "The base address must be a public host name, e.g. api.example.com, not an IP address or an internal name." };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, url: `https://${parsed.host.toLowerCase()}${path}`, host };
}

const httpsUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    const result = normalizeApiToolBaseUrl(value);
    if (!result.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message });
  });

/**
 * How the key is sent. Exactly one of the three:
 *  - bearer: `Authorization: Bearer <key>`
 *  - header: `<name>: <prefix><key>` (Fal.ai: name "Authorization", prefix "Key ")
 *  - query:  `?<name>=<key>`
 * `secretId` is the company secret holding the key; the value never travels
 * in this object.
 */
export const apiToolAuthSchema = z
  .object({
    kind: z.enum(API_TOOL_AUTH_KINDS),
    name: z.string().trim().max(128).optional(),
    prefix: z.string().max(64).optional(),
    secretId: z.string().uuid({ message: "Pick the secret that holds the key." }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "header") {
      if (!value.name) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "Say which header carries the key, e.g. Authorization or X-API-Key." });
      } else if (!HEADER_NAME_RE.test(value.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "That is not a valid header name." });
      }
    }
    if (value.kind === "query") {
      if (!value.name) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "Say which query parameter carries the key, e.g. api_key." });
      } else if (!QUERY_NAME_RE.test(value.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "That is not a valid query parameter name." });
      }
      if (value.prefix) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prefix"], message: "A prefix only applies to a header." });
      }
    }
    if (value.kind === "bearer" && value.prefix) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prefix"], message: 'Bearer already adds "Bearer ". Pick "A header" to use another prefix.' });
    }
    if (value.prefix && /[\r\n]/.test(value.prefix)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prefix"], message: "The prefix cannot contain a line break." });
    }
  });

export type ApiToolAuth = z.infer<typeof apiToolAuthSchema>;

export const apiToolActionInputSchema = z
  .object({
    name: z.string().trim().regex(API_TOOL_INPUT_NAME_RE, "Input names are letters, digits, _ . or -, starting with a letter."),
    type: z.enum(API_TOOL_INPUT_TYPES).default("string"),
    required: z.boolean().default(false),
    description: z.string().trim().max(280).optional(),
  })
  .strict();

export type ApiToolActionInput = z.infer<typeof apiToolActionInputSchema>;

/**
 * One thing an agent may call. `path` is appended to the base address and may
 * carry `{name}` placeholders, each filled from the input of that name. Any
 * other input goes to the query string (GET, DELETE) or the JSON body
 * (POST, PUT, PATCH).
 */
export const apiToolActionSchema = z
  .object({
    name: z.string().trim().regex(API_TOOL_ACTION_NAME_RE, "Action names are lower-case letters, digits and _, starting with a letter (e.g. list_invoices)."),
    method: z.enum(API_TOOL_METHODS),
    path: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => value.startsWith("/"), "The path must start with /.")
      .refine((value) => !/[?#\s]/.test(value), "The path cannot contain ?, # or spaces.")
      .refine(
        (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
        'The path cannot contain a "." or ".." part.',
      ),
    description: z.string().trim().max(280).default(""),
    inputs: z.array(apiToolActionInputSchema).max(API_TOOL_MAX_INPUTS_PER_ACTION).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    value.inputs.forEach((input, index) => {
      if (names.has(input.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["inputs", index, "name"], message: `The input "${input.name}" is listed twice.` });
      }
      names.add(input.name);
    });
    for (const placeholder of value.path.matchAll(/\{([^{}]+)\}/g)) {
      if (!names.has(placeholder[1]!)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["path"],
          message: `The path uses {${placeholder[1]}} but there is no input called "${placeholder[1]}".`,
        });
      }
    }
  });

export type ApiToolAction = z.infer<typeof apiToolActionSchema>;

const actionsSchema = z
  .array(apiToolActionSchema)
  .max(API_TOOL_MAX_ACTIONS, `At most ${API_TOOL_MAX_ACTIONS} actions per tool.`)
  .superRefine((actions, ctx) => {
    const seen = new Set<string>();
    actions.forEach((action, index) => {
      if (seen.has(action.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "name"], message: `Two actions are called "${action.name}". Give each action its own name.` });
      }
      seen.add(action.name);
    });
  });

export const apiToolBodySchema = z
  .object({
    name: z.string().trim().min(1, "Give the tool a name.").max(100),
    description: z.string().trim().max(280).default(""),
    baseUrl: httpsUrl,
    auth: apiToolAuthSchema,
    actions: actionsSchema.default([]),
    openapiUrl: httpsUrl.nullable().optional(),
    dailyCap: z.number().int().min(1).max(API_TOOL_MAX_DAILY_CAP).default(API_TOOL_DEFAULT_DAILY_CAP),
    status: z.enum(["active", "disabled"]).default("active"),
  })
  .strict();

export type ApiToolBody = z.infer<typeof apiToolBodySchema>;

export const apiToolUpdateSchema = apiToolBodySchema.partial();

export type ApiToolUpdate = z.infer<typeof apiToolUpdateSchema>;

export const agentApiToolSelectionSchema = z
  .object({
    desiredToolIds: z.array(z.string().uuid()).max(200),
  })
  .strict();

export type AgentApiToolSelection = z.infer<typeof agentApiToolSelectionSchema>;

/** Body of POST .../api-tools/import-openapi: where the spec lives. */
export const apiToolImportOpenApiSchema = z
  .object({
    url: httpsUrl,
  })
  .strict();

export type ApiToolImportOpenApi = z.infer<typeof apiToolImportOpenApiSchema>;

/** Body of POST .../api-tools/:toolId/actions/:action/run. */
export const runApiToolActionSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type RunApiToolActionBody = z.infer<typeof runApiToolActionSchema>;

/**
 * The JSON schema handed to a model for one action, built from the simple
 * input list. Shared so the quick-agent offering and the full-agent
 * announcement describe an action the same way.
 */
export function apiToolActionInputJsonSchema(action: Pick<ApiToolAction, "inputs">): {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
} {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const input of action.inputs) {
    const property: Record<string, unknown> =
      input.type === "json" ? { description: input.description ?? "A JSON value (object or array)." } : { type: input.type };
    if (input.description && input.type !== "json") property.description = input.description;
    properties[input.name] = property;
    if (input.required) required.push(input.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}
